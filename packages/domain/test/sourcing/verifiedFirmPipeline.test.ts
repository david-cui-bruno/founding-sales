import {randomUUID,createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,it,expect} from 'vitest';
import type {CandidateInput,SourceObservation,QualificationFact} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveCandidate,listCandidates,reviewCandidate,deleteCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,finishQualification,QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '../../sourcing/qualificationStore.ts';
import {evaluateQualification} from '../../sourcing/qualificationDecision.ts';
import {advanceVerifiedFirm} from '../../sourcing/verifiedFirmPipeline.ts';
import {VERIFIED_FIRM_POLICY_VERSION} from '../../sourcing/verifiedFirmPolicy.ts';
import {recordStatePosture} from '../../policy/postures.ts';
import {POSTURE_STATEMENTS} from '../../src/rules/statePosture.ts';
import {newFirmSource} from '../../today/build.ts';
import {runFirmResearch} from '../../research/enrichment.ts';
import {readCallBrief} from '../../research/brief.ts';
import {readFirmSourcing} from '../../sourcing/attribution.ts';
let db:TestDatabase,seed:TwoWorkspaces,serial=200;
const user=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',role:'admin',userId:seed.alpha.admin.userId}),db.session);
const worker=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
const currentAttestation=()=>({policyVersion:QUALIFICATION_POLICY_VERSION,promptVersion:QUALIFICATION_PROMPT_VERSION,verifiedFirmPolicyVersion:VERIFIED_FIRM_POLICY_VERSION,reportSha256:'a'.repeat(64),reviewedEligible:3,falseEligible:0});
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);for(const state of ['TX','RI','MA'] as const)await tx(()=>recordStatePosture(user(),{state,effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));});
afterAll(async()=>db.drop());
beforeEach(async()=>{
 await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM sourcing_discovery_settings');await db.session.query('DELETE FROM daily_counters');await db.session.query('DELETE FROM research_settings');await db.session.query('DELETE FROM jobs');
 await db.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,auto_admission_enabled,owner_user_id,qualification_evaluation) VALUES($1,true,$2,$3::jsonb)',[seed.alpha.workspaceId,seed.alpha.admin.userId,JSON.stringify(currentAttestation())]);
});
async function draft(options:{payload?:CandidateInput;phone?:string|null;locality?:string;region?:CandidateInput['region'];identityName?:string;legacyDuplicate?:boolean;splitOffice?:boolean}={}){
 const n=serial++,payload:CandidateInput=options.payload??{firmName:`Verified Office ${n} LLC`,website:`https://verified-${n}.example.test/`,sourceUrl:`https://verified-${n}.example.test/`,locality:options.locality??'Dallas',region:options.region??'TX',signal:'fit_only',evidence:'Search only, not proof',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Tavily Basic search · not verified'};
 let candidateId:string;
 if(options.legacyDuplicate){candidateId=(await db.session.query<{id:string}>('INSERT INTO sourcing_candidates(workspace_id,identity_key,payload) VALUES($1,$2,$3::jsonb) RETURNING id',[seed.alpha.workspaceId,createHash('sha256').update(randomUUID()).digest('hex'),JSON.stringify(payload)])).rows[0]!.id;}
 else{const saved=await tx(()=>saveCandidate(user(),payload));if(!saved.ok)throw new Error(saved.reason);candidateId=saved.value.id;}
 const requested=await tx(()=>requestQualification(user(),{candidateId,expectedRevision:1}));if(!requested.ok)throw new Error(requested.reason);
 const phone=options.phone===undefined?`(214) 555-${String(n).padStart(4,'0')}`:options.phone;
 const blocks=[{id:'office',text:`${options.identityName??payload.firmName} office: ${payload.locality}, ${payload.region}. We provide residential property management.`},{id:'phone',text:phone?`Contact ${payload.firmName} at ${phone}.`:'No phone published.'}];
 const observation:SourceObservation={id:randomUUID(),url:payload.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 let facts:QualificationFact[]=[...(['firm_identity','residential_management','service_area'] as const).map(kind=>({kind,observationId:observation.id,blockId:'office',value:blocks[0]!.text})),...(phone?[{kind:'business_phone' as const,observationId:observation.id,blockId:'phone',value:blocks[1]!.text}]:[])];
 if(options.splitOffice&&phone){
  const texts=[`${payload.firmName} provides residential property management.`,`We serve ${payload.locality}, ${payload.region}.`,payload.firmName,phone,'office@fixture.example.test','Office Location','12 Example Street',`${payload.locality}, ${payload.region} 75001`];
  observation.blocks=texts.map((text,n)=>({id:`b${n}`,text}));
  facts=([['firm_identity',0],['residential_management',0],['service_area',1],['business_phone',3]] as const).map(([kind,n])=>({kind,observationId:observation.id,blockId:`b${n}`,value:texts[n]!}));
 }
 const saved=await tx(()=>finishQualification(user(),{runId:requested.value.runId,observations:[observation],facts,reason:null}));if(!saved.ok)throw new Error(saved.reason);
 await tx(()=>evaluateQualification(user(),{runId:requested.value.runId}));
 return {candidateId,runId:requested.value.runId,payload,phone};
}
const advance=(runId:string)=>tx(()=>advanceVerifiedFirm(worker(),{runId}));
const admission=async(candidateId:string)=>(await db.session.query<{firm_id:string;route_id:string}>('SELECT firm_id,route_id FROM sourcing_admissions WHERE candidate_id=$1',[candidateId])).rows[0];
it.each(['denial','neighbor'] as const)('never auto-Keeps or admits literal %s evidence',async scenario=>{
 const d=await draft(),name=d.payload.firmName;
 const source=(await db.session.query<{observations:SourceObservation[]}>('SELECT observations FROM sourcing_qualification_runs WHERE id=$1',[d.runId])).rows[0]!.observations[0]!;
 const texts=scenario==='denial'?[name,'We do not manage residential properties. We manage commercial properties only.',`${name} office: Dallas, TX. Contact ${name} (214) 555-0190.`]:[`${name} provides residential property management.`,`${name} office: Dallas, TX.`,`${name} office: Austin, TX.`,`Contact ${name} Austin office: (512) 555-0190.`];
 source.blocks=texts.map((text,n)=>({id:`b${n}`,text}));
 const indices=scenario==='denial'?[0,1,2,2]:[0,0,1,3];
 const facts=['firm_identity','residential_management','service_area','business_phone'].map((kind,n)=>({kind,observationId:source.id,blockId:`b${indices[n]}`,value:texts[indices[n]!]!}));
 await db.session.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb,facts=$3::jsonb WHERE id=$1',[d.runId,JSON.stringify([source]),JSON.stringify(facts)]);
 await advance(d.runId);expect(await admission(d.candidateId)).toBeUndefined();
 expect((await db.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[d.candidateId])).rows[0]).toEqual({status:'needs_review',revision:1});
 expect((await db.session.query('SELECT admission_reason FROM sourcing_qualification_runs WHERE id=$1',[d.runId])).rows[0]).toEqual({admission_reason:scenario==='denial'?'residential_fit_unknown':'phone_association_ambiguous'});
 const queue=await listCandidates(user(),{status:'needs_review',offset:0});if(!queue.ok)throw new Error(queue.reason);
 expect(queue.value.candidates.map(c=>c.id)).toEqual(scenario==='denial'?[]:[d.candidateId]);
});
it('automatically Keeps a split-card bare-phone proof, researches, then exposes a useful sourced call brief without outreach',async()=>{
 const d=await draft({splitOffice:true});
 const untouched=['contacts','opportunities','sequence_enrollments','outbound_messages','outreach_plans','call_sessions','call_logs'];
 const counts=async()=>Promise.all(untouched.map(async table=>(await db.session.query<{count:number}>(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1`,[seed.alpha.workspaceId])).rows[0]!.count));
 const before=await counts();await advance(d.runId);await advance(d.runId);
 expect((await db.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[d.candidateId])).rows[0]).toEqual({status:'kept',revision:2});
 const a=await admission(d.candidateId);expect(a).toBeDefined();if(!a)throw new Error('admission_missing');
 expect(await counts()).toEqual(before);
 expect((await db.session.query("SELECT id FROM jobs WHERE kind='research.firm' AND payload->>'firmId'=$1",[a.firm_id])).rows).toHaveLength(1);
 expect((await db.session.query("SELECT id FROM audit_events WHERE action='sourcing.candidate_auto_kept' AND subject_id=$1",[d.candidateId])).rows).toHaveLength(1);
 expect(await tx(()=>reviewCandidate(user(),{id:d.candidateId,expectedRevision:1,status:'dismissed'}))).toEqual({ok:false,reason:'candidate_changed'});
 const source=newFirmSource(),at=new Date().toISOString();
 expect((await source.find(worker(),{businessDate:at.slice(0,10),businessTimeZone:'America/New_York',now:at,firmId:a.firm_id})).map(row=>row.firmId)).not.toContain(a.firm_id);
 const html='<p>We manage residential properties for local homeowners.</p>',hash=createHash('sha256').update(html).digest('hex');
 const result=await tx(()=>runFirmResearch(worker(),{firmId:a.firm_id,revision:1,trigger:'sweep',at,pageFetch:{providerKey:'company_page',fetchPages:async()=>({ok:true,costCents:0,value:{pages:[{url:d.payload.website,contentHash:hash,contentType:'text/html',body:new TextEncoder().encode(html),retrievedAt:at,firstParty:true}],skipped:{}}})},extraction:{providerKey:'anthropic_extraction',countInputTokens:async()=>100,extract:async()=>({ok:true,costCents:1,value:{selections:[{key:'target_fit',sourceReference:d.payload.website,blockId:'b1'}],questions:['How is maintenance coordinated?','Who handles work orders?'],opening:'Your site describes residential property management.',modelName:'claude-haiku-4-5',inputTokens:100,outputTokens:50}})}}));
 expect(result).toMatchObject({ok:true,value:{outcome:'completed',factsRecorded:1}});expect((await readCallBrief(worker(),a.firm_id))?.whyFit).toHaveLength(1);
 expect((await source.find(worker(),{businessDate:at.slice(0,10),businessTimeZone:'America/New_York',now:at,firmId:a.firm_id})).map(row=>row.firmId)).toContain(a.firm_id);
 expect(await counts()).toEqual(before);
});
it.each([{phone:null,reason:'business_phone_unresolved'},{locality:'Unknown Texas locality',reason:'zone_unresolved'}])('keeps verified identity pending $reason outside manual review',async options=>{
 const d=await draft(options);await advance(d.runId);
 expect((await db.session.query('SELECT status FROM sourcing_candidates WHERE id=$1',[d.candidateId])).rows[0]).toEqual({status:'kept'});
 expect((await db.session.query('SELECT admission_reason FROM sourcing_qualification_runs WHERE id=$1',[d.runId])).rows[0]).toEqual({admission_reason:options.reason});
 expect(await admission(d.candidateId)).toBeUndefined();
 expect(await listCandidates(user(),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[],hasMore:false}});
});
it('shows only unresolved identity and leaves temporary unavailable evidence pending',async()=>{
 const unclear=await draft({identityName:'Another Company LLC'});await advance(unclear.runId);
 const waiting=await draft();await db.session.query("UPDATE sourcing_qualification_runs SET state='unavailable',reason='source_unavailable' WHERE id=$1",[waiting.runId]);await advance(waiting.runId);
 const result=await listCandidates(user(),{status:'needs_review',offset:0});if(!result.ok)throw new Error(result.reason);
 expect(result.value.candidates.map(c=>c.id)).toEqual([unclear.candidateId]);
 expect(Object.keys(result.value).sort()).toEqual(['candidates','discovery','hasMore','qualificationWaitReason']);
});
it('requires new attestation and active owner before any automatic status or CRM change',async()=>{
 const d=await draft();await db.session.query("UPDATE sourcing_discovery_settings SET qualification_evaluation=qualification_evaluation-'verifiedFirmPolicyVersion'");await advance(d.runId);
 expect(await admission(d.candidateId)).toBeUndefined();expect((await db.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[d.candidateId])).rows[0]).toEqual({status:'needs_review',revision:1});
 for(const oldVersion of [{policyVersion:'qualification-v4'},{verifiedFirmPolicyVersion:'verified-firm-v2'},{verifiedFirmPolicyVersion:'verified-firm-v1'}]){
  const attestation={...currentAttestation(),...oldVersion};
  await db.session.query('UPDATE sourcing_discovery_settings SET qualification_evaluation=$1::jsonb',[JSON.stringify(attestation)]);await advance(d.runId);
  expect(await admission(d.candidateId)).toBeUndefined();expect((await db.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[d.candidateId])).rows[0]).toEqual({status:'needs_review',revision:1});
  expect((await db.session.query('SELECT qualification_evaluation FROM sourcing_discovery_settings')).rows[0]).toEqual({qualification_evaluation:attestation});
 }
 await db.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);await db.session.query('UPDATE sourcing_discovery_settings SET qualification_evaluation=$1::jsonb,owner_user_id=$2',[JSON.stringify(currentAttestation()),seed.alpha.salesperson.userId]);await advance(d.runId);expect(await admission(d.candidateId)).toBeUndefined();await db.session.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
});
it('appends linked duplicate evidence idempotently, dismisses only the extra draft, and erases its source safely',async()=>{
 const first=await draft();await advance(first.runId);const a=await admission(first.candidateId);if(!a)throw new Error('first_missing');
 const second=await draft({payload:first.payload,phone:first.phone,legacyDuplicate:true});await advance(second.runId);await advance(second.runId);
 expect((await admission(second.candidateId))?.firm_id).toBe(a.firm_id);
 expect((await db.session.query('SELECT status FROM sourcing_candidates WHERE id=$1',[second.candidateId])).rows[0]).toEqual({status:'dismissed'});
 expect((await db.session.query('SELECT id FROM firms WHERE website=$1',[first.payload.website])).rows).toHaveLength(1);
 const sources=await readFirmSourcing(user(),a.firm_id);expect(sources?.sources.some(s=>s.qualificationRunId===second.runId&&s.sourceAvailable)).toBe(true);
 const original=(await db.session.query('SELECT observations FROM sourcing_qualification_runs WHERE id=$1',[first.runId])).rows[0];
 await tx(()=>deleteCandidate(user(),{id:second.candidateId,expectedRevision:3}));
 expect((await db.session.query('SELECT observations FROM sourcing_qualification_runs WHERE id=$1',[first.runId])).rows[0]).toEqual(original);
 expect((await readFirmSourcing(user(),a.firm_id))?.sources.filter(s=>s.candidateId===null).every(s=>!s.sourceAvailable)).toBe(true);
});
it('refuses stale, dismissed, identity-blocked and changed revision outcomes without automatic publication',async()=>{
 for(const mutation of ['stale','dismissed','blocked','revision','policy','prompt']){
  const d=await draft();
  if(mutation==='stale')await db.session.query("UPDATE sourcing_qualification_runs SET observations=jsonb_set(observations,'{0,retrievedAt}',to_jsonb((now()-interval '8 days')::text)) WHERE id=$1",[d.runId]);
  if(mutation==='dismissed')await tx(()=>reviewCandidate(user(),{id:d.candidateId,expectedRevision:1,status:'dismissed'}));
  if(mutation==='blocked')await db.session.query('UPDATE sourcing_candidates SET qualification_blocked=true WHERE id=$1',[d.candidateId]);
  if(mutation==='revision')await db.session.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1',[d.candidateId]);
  if(mutation==='policy')await db.session.query("UPDATE sourcing_qualification_runs SET policy_version='qualification-v4' WHERE id=$1",[d.runId]);
  if(mutation==='prompt')await db.session.query("UPDATE sourcing_qualification_runs SET prompt_version='qualification-old' WHERE id=$1",[d.runId]);
  const historical=(await db.session.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[d.runId])).rows[0];
  const jobs=(await db.session.query('SELECT id,kind,payload FROM jobs ORDER BY id')).rows;
  await advance(d.runId);expect(await admission(d.candidateId)).toBeUndefined();
  if(mutation==='policy'){
   expect((await db.session.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[d.runId])).rows[0]).toEqual(historical);
   expect((await db.session.query('SELECT id,kind,payload FROM jobs ORDER BY id')).rows).toEqual(jobs);
   expect((await db.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[d.candidateId])).rows[0]).toEqual({status:'needs_review',revision:1});
  }
 }
});
it('keeps distinct branch paths for human identity review instead of merging on host, name or phone',async()=>{
 const first=await draft();await advance(first.runId);const a=await admission(first.candidateId);if(!a)throw new Error('first_missing');
 const second=await draft({payload:{...first.payload,website:`${first.payload.website}another-office`,sourceUrl:`${first.payload.website}another-office`},phone:first.phone});
 await advance(second.runId);expect(await admission(second.candidateId)).toBeUndefined();
 expect((await db.session.query('SELECT admission_reason FROM sourcing_qualification_runs WHERE id=$1',[second.runId])).rows[0]).toEqual({admission_reason:'firm_identity_ambiguous'});
 const listed=await listCandidates(user(),{status:'needs_review',offset:0});expect(listed).toMatchObject({ok:true,value:{candidates:[{id:second.candidateId,status:'kept'}]}});
 expect((await db.session.query('SELECT id FROM firms WHERE website=$1',[first.payload.website])).rows).toHaveLength(1);
});
