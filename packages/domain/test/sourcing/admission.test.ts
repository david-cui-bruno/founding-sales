import type {SourceObservation,QualificationFact,QualificationVerdict} from '@fss/contracts';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,finishQualification} from '../../sourcing/qualificationStore.ts';
import {evaluateQualification} from '../../sourcing/qualificationDecision.ts';
import {admitCandidate} from '../../sourcing/admission.ts';
import {recordStatePosture} from '../../policy/postures.ts';
import {POSTURE_STATEMENTS} from '../../src/rules/statePosture.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);await tx(()=>recordStatePosture(ctx(),{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));});
afterAll(async()=>db.drop());
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM sourcing_discovery_settings');await db.session.query('DELETE FROM daily_counters');});
let phoneSerial=100;
async function qualified(name:string,options:{locality?:string;website?:string;need?:string;phone?:string}={}){
 const locality=options.locality??'Dallas',website=options.website??`https://${name.toLowerCase().replaceAll(' ','')}.example.test/`;
 const candidate=await tx(()=>saveCandidate(ctx(),{firmName:name,website,locality,region:'TX',signal:'fit_only',evidence:'Maintenance work',sourceUrl:website,observedOn:'2026-10-01',preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);
 const request=await tx(()=>requestQualification(ctx(),{candidateId:candidate.value.id,expectedRevision:1}));if(!request.ok)throw new Error(request.reason);
 const id=randomUUID(),date=new Date().toISOString().slice(0,10);
 const blocks=[{id:'firm',text:`${name} is a residential property management company in ${locality}, Texas.`},{id:'phone',text:`Contact ${name} at ${options.phone??`(214) 555-${String(phoneSerial++).padStart(4,'0')}`}.`},{id:'need',text:options.need??'Our team is overwhelmed by maintenance calls.'},{id:'date',text:`Published ${date}`}];
 const facts=[['firm_identity','firm'],['residential_management','firm'],['service_area','firm'],['business_phone','phone'],['operational_burden','need']].map(([kind,blockId])=>({kind,blockId,observationId:id,value:blocks.find(b=>b.id===blockId)!.text}));
 const finished=await tx(()=>finishQualification(ctx(),{runId:request.value.runId,reason:null,observations:[{id,url:website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:`${date}T00:00:00Z`,publishedAtBlockId:'date',firstParty:true,truncated:false,blocks}],facts}));if(!finished.ok)throw new Error(finished.reason);
 await tx(()=>evaluateQualification(ctx(),{runId:request.value.runId}));
 return {candidateId:candidate.value.id,expectedRevision:1,qualificationRunId:request.value.runId,mode:'reviewed' as const};
}
it('admits one firm-level route idempotently without creating deals, contacts or outreach',async()=>{
 const input=await qualified('First PM');
 const result=await tx(()=>admitCandidate(ctx(),input));expect(result).toMatchObject({ok:true,value:{alreadyAdmitted:false}});
 if(!result.ok)throw new Error(result.reason);
 expect(await tx(()=>admitCandidate(ctx(),input))).toEqual({ok:true,value:{...result.value,alreadyAdmitted:true}});
 const firmId=result.value.firmId;
 expect((await db.session.query('SELECT assigned_user_id FROM firms WHERE id=$1',[firmId])).rows[0]).toEqual({assigned_user_id:seeded.alpha.admin.userId});
 for(const table of ['contacts','opportunities','sequence_enrollments'])expect((await db.session.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND firm_id=$2`,[seeded.alpha.workspaceId,firmId])).rows).toHaveLength(0);
 expect((await db.session.query('SELECT contact_id,e164 FROM phone_routes WHERE id=$1',[result.value.routeId])).rows[0]).toEqual({contact_id:null,e164:'+12145550100'});
});
async function enableAutomatic(){await db.session.query(`INSERT INTO sourcing_discovery_settings(workspace_id,auto_admission_enabled,qualification_evaluation) VALUES($1,true,$2::jsonb)`,[seeded.alpha.workspaceId,JSON.stringify({policyVersion:'qualification-v1',promptVersion:'qualification-contact-v3',reportSha256:'a'.repeat(64),reviewedEligible:1,falseEligible:0})]);}
it('requires an explicit owner for automatic admission in a workspace with multiple sellers',async()=>{
 const input=await qualified('Owner PM');await enableAutomatic();expect(await tx(()=>admitCandidate(ctx(),{...input,mode:'automatic'}))).toEqual({ok:false,reason:'sourcing_owner_required'});
});
it('refuses stale evidence, missing phone and an unresolved Texas locality with no CRM side effects',async()=>{
 const input=await qualified('Stale PM');await db.session.query("UPDATE sourcing_qualification_runs SET observations=jsonb_set(observations,'{0,retrievedAt}',to_jsonb((now()-interval '8 days')::text)) WHERE id=$1",[input.qualificationRunId]);
 expect((await tx(()=>admitCandidate(ctx(),input))).ok).toBe(false);
 const missing=await qualified('No Phone PM',{phone:'unknown'});expect((await tx(()=>admitCandidate(ctx(),missing))).ok).toBe(false);
 const zone=await qualified('Zone PM',{locality:'Texas'});expect(await tx(()=>admitCandidate(ctx(),zone))).toEqual({ok:false,reason:'zone_unresolved'});
 expect((await db.session.query("SELECT id FROM firms WHERE name IN ('Stale PM','No Phone PM','Zone PM')")).rows).toHaveLength(0);
});
it('keeps a fit-only candidate in review for automatic mode but permits explicit reviewed admission',async()=>{
 const input=await qualified('Fit PM',{need:'We provide 24/7 maintenance services.'});await enableAutomatic();
 expect(await tx(()=>admitCandidate(ctx(),{...input,mode:'automatic'}))).toEqual({ok:false,reason:'qualification_requires_review'});
 expect(await tx(()=>admitCandidate(ctx(),input))).toMatchObject({ok:true});
});
it('serializes concurrent repeated admission and does not replace the assignee',async()=>{
 const input=await qualified('Concurrent PM');const session=await db.appRuntimeSession();
 const second=repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),session);
 const results=await Promise.all([tx(()=>admitCandidate(ctx(),input)),withTransaction(session,()=>admitCandidate(second,input))]);
 expect(results.every(r=>r.ok)).toBe(true);expect(results.filter(r=>r.ok&&r.value.alreadyAdmitted)).toHaveLength(1);
 expect((await db.session.query("SELECT id FROM firms WHERE name='Concurrent PM'")).rows).toHaveLength(1);
});
it('rejects stopped phone handles and allows email-only stops',async()=>{
 const {recordSuppression}=await import('../../suppression/events.ts');const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');
 const stopped=await qualified('Stopped PM',{phone:'(214) 555-0198'});
 await tx(()=>recordSuppression(ctx(),{scope:'handle',value:'+12145550198',source:'prospect_do_not_call',channel:'phone',journal:recordingSuppressionJournal()}));
 expect(await tx(()=>admitCandidate(ctx(),stopped))).toEqual({ok:false,reason:'phone_or_firm_stopped'});
 await tx(()=>recordSuppression(ctx(),{scope:'handle',value:'contact@emailonly.example.test',source:'prospect_opt_out',channel:'email',journal:recordingSuppressionJournal()}));
 const email=await qualified('EmailOnly PM');expect(await tx(()=>admitCandidate(ctx(),email))).toMatchObject({ok:true});
});
it('does not merge separate franchise branches or same-name firms in different metros',async()=>{
 const first=await qualified('Branch PM',{website:'https://branch.example.test/dallas',phone:'(214) 555-0170'});expect(await tx(()=>admitCandidate(ctx(),first))).toMatchObject({ok:true});
 const second=await qualified('Branch PM',{website:'https://branch.example.test/houston',locality:'Houston',phone:'(713) 555-0171'});expect(await tx(()=>admitCandidate(ctx(),second))).toEqual({ok:false,reason:'firm_identity_ambiguous'});
 const separate=await qualified('Branch PM',{website:'https://separate.example.test/',locality:'Austin',phone:'(512) 555-0172'});expect(await tx(()=>admitCandidate(ctx(),separate))).toMatchObject({ok:true});
});
it('requires calling state activation and rechecks assignment under the firm lock',async()=>{
 const input=await qualified('Assignment PM');const first=await tx(()=>admitCandidate(ctx(),input));if(!first.ok)throw new Error(first.reason);
 await db.session.query('DELETE FROM sourcing_admissions WHERE candidate_id=$1',[input.candidateId]);
 await db.session.query("UPDATE sourcing_qualification_runs SET state='eligible' WHERE id=$1",[input.qualificationRunId]);
 await db.session.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1',[first.value.firmId,seeded.alpha.salesperson.userId]);
 expect(await tx(()=>admitCandidate(ctx(),input))).toEqual({ok:false,reason:'firm_assigned_elsewhere'});
 const newInput=await qualified('State PM');
 await db.session.query('BEGIN');
 await db.session.query('DELETE FROM state_postures WHERE workspace_id=$1',[seeded.alpha.workspaceId]);
 expect(await admitCandidate(ctx(),newInput)).toEqual({ok:false,reason:'calling_state_not_enabled'});await db.session.query('ROLLBACK');
});
it('carries admission provenance to the surviving firm and its existing route on merge',async()=>{
 const {createFirm}=await import('../../crm/firms.ts');const {addPhoneRoute}=await import('../../crm/routes.ts');const {mergeFirms}=await import('../../crm/merges.ts');const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');
 const input=await qualified('Merge PM',{phone:'(214) 555-0180'});const admitted=await tx(()=>admitCandidate(ctx(),input));if(!admitted.ok)throw new Error(admitted.reason);
 const target=await tx(()=>createFirm(ctx(),{name:'Merge Survivor',assignedUserId:seeded.alpha.admin.userId}));if(!target.ok)throw new Error(target.reason);
 const route=await tx(()=>addPhoneRoute(ctx(),{firmId:target.value.id,e164:'+12145550180',source:'website'}));if(!route.ok)throw new Error(route.reason);
 const merged=await tx(()=>mergeFirms(ctx(),{sourceFirmId:admitted.value.firmId,targetFirmId:target.value.id,journal:recordingSuppressionJournal()}));expect(merged.ok).toBe(true);
 expect((await db.session.query('SELECT firm_id,route_id FROM sourcing_admissions WHERE candidate_id=$1',[input.candidateId])).rows).toEqual([{firm_id:target.value.id,route_id:route.value.id}]);
});
it('sees a stop committed while admission is waiting, before creating any firm',async()=>{
 const {recordSuppression}=await import('../../suppression/events.ts');const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');const {lockSendGateForStopFact}=await import('../../policy/sendGate.ts');
 const input=await qualified('Stop Race PM',{phone:'(214) 555-0199'});
 const connection=await db.appRuntimeSession();const stopContext=repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),connection);
 await connection.query('BEGIN');await lockSendGateForStopFact(stopContext);
 const admission=tx(()=>admitCandidate(ctx(),input));
 await recordSuppression(stopContext,{scope:'handle',value:'+12145550199',source:'prospect_do_not_call',channel:'phone',journal:recordingSuppressionJournal()});await connection.query('COMMIT');
 expect(await admission).toEqual({ok:false,reason:'phone_or_firm_stopped'});
 expect((await db.session.query("SELECT id FROM firms WHERE name='Stop Race PM'")).rows).toHaveLength(0);
});
it('keeps SQL and TypeScript sourcing order aligned and removes a wrong-firm contribution without deleting CRM history',async()=>{
 const {listTodayCards,businessDateOf}=await import('../../today/snapshots.ts');const {compareTodayCards}=await import('../../today/lanes.ts');const {recordSourcingFeedback}=await import('../../sourcing/feedback.ts');const {readFirmQualification}=await import('../../sourcing/qualificationStore.ts');
 const fit=await qualified('Rank Fit PM',{need:'We provide routine maintenance.'});const burden=await qualified('Rank Burden PM');
 const fitResult=await tx(()=>admitCandidate(ctx(),fit)),burdenResult=await tx(()=>admitCandidate(ctx(),burden));if(!fitResult.ok||!burdenResult.ok)throw new Error('fixtures');
 const snapshotDate=await businessDateOf(ctx(),new Date().toISOString());
 const ids=new Set([fitResult.value.firmId,burdenResult.value.firmId]);
 const cards=(await listTodayCards(ctx(),{snapshotDate})).filter(card=>ids.has(card.firmId));
 expect(cards.map(card=>card.firmId)).toEqual([burdenResult.value.firmId,fitResult.value.firmId]);expect([...cards].reverse().sort(compareTodayCards)).toEqual(cards);
 expect(await readFirmQualification(ctx(),burdenResult.value.firmId)).toMatchObject({candidateId:burden.candidateId});
 await tx(()=>recordSourcingFeedback(ctx(),{candidateId:burden.candidateId,qualificationRunId:burden.qualificationRunId,code:'wrong_firm'}));
 const corrected=(await listTodayCards(ctx(),{snapshotDate})).find(card=>card.firmId===burdenResult.value.firmId);
 expect(corrected?.sourceRank).toBe(5);expect((await db.session.query('SELECT id FROM firms WHERE id=$1',[burdenResult.value.firmId])).rows).toHaveLength(1);
 expect((await db.session.query('SELECT association_review_required FROM sourcing_admissions WHERE candidate_id=$1',[burden.candidateId])).rows[0]).toEqual({association_review_required:true});
});

it('rechecks activation and versioned evaluation inside admission while reviewed admission remains available',async()=>{
 const input=await qualified('Activation PM');
 expect(await tx(()=>admitCandidate(ctx(),{...input,mode:'automatic'}))).toEqual({ok:false,reason:'automatic_admission_disabled'});
 await db.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,auto_admission_enabled,owner_user_id) VALUES($1,true,$2)',[seeded.alpha.workspaceId,seeded.alpha.admin.userId]);
 expect(await tx(()=>admitCandidate(ctx(),{...input,mode:'automatic'}))).toEqual({ok:false,reason:'evaluation_required'});
 expect(await tx(()=>admitCandidate(ctx(),input))).toMatchObject({ok:true});
});

it('counts only independent supporting sources, not extra fetched pages or copied need text',async()=>{
 const {listTodayCards,businessDateOf}=await import('../../today/snapshots.ts');
 const input=await qualified('Corroboration PM');const admitted=await tx(()=>admitCandidate(ctx(),input));if(!admitted.ok)throw new Error(admitted.reason);
 const row=(await db.session.query<{observations:SourceObservation[];facts:QualificationFact[];verdict:QualificationVerdict}>('SELECT observations,facts,verdict FROM sourcing_qualification_runs WHERE id=$1',[input.qualificationRunId])).rows[0]!;
 const original=row.observations[0]!,copyId=randomUUID(),unrelatedId=randomUUID();
 const duplicate={...original,id:copyId,url:original.url+'news',relevantTextHash:'c'.repeat(64)};
 const unrelated={...original,id:unrelatedId,url:original.url+'contact',relevantTextHash:'d'.repeat(64)};
 const need=row.facts.find(f=>f.kind==='operational_burden')!;
 await db.session.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb,facts=$3::jsonb,verdict=$4::jsonb WHERE id=$1',[input.qualificationRunId,JSON.stringify([...row.observations,duplicate,unrelated]),JSON.stringify([...row.facts,{...need,observationId:copyId}]),JSON.stringify({...row.verdict,evidenceIds:[original.id,copyId]})]);
 const cards=await listTodayCards(ctx(),{snapshotDate:await businessDateOf(ctx(),new Date().toISOString())});
 expect(cards.find(c=>c.firmId===admitted.value.firmId)?.sourceCount).toBe(1);
});
it('uses only an approved targeting order for the new-firm lane',async()=>{
 const {listTodayCards,businessDateOf}=await import('../../today/snapshots.ts');const {saveTargetingProposal,applyTargetingProposal}=await import('../../sourcing/targetingProposals.ts');
 const fit=await qualified('Policy Fit PM',{need:'We provide routine maintenance.'}),burden=await qualified('Policy Burden PM');
 const f=await tx(()=>admitCandidate(ctx(),fit)),b=await tx(()=>admitCandidate(ctx(),burden));if(!f.ok||!b.ok)throw new Error('fixtures');
 const snapshotDate=await businessDateOf(ctx(),new Date().toISOString()),ids=new Set([f.value.firmId,b.value.firmId]);
 const order=async()=>(await listTodayCards(ctx(),{snapshotDate})).filter(c=>ids.has(c.firmId)).map(c=>c.firmId);
 const proposal=await tx(()=>saveTargetingProposal(ctx(),{basePolicyVersion:'targeting-v1',queryChanges:[],rankOrder:['fit_only','operational_burden','help_request','investigation'],evidenceIds:[],rationale:'Try a reviewed fit-first order without relaxing admission.'}));if(!proposal.ok)throw new Error(proposal.reason);
 expect(await order()).toEqual([b.value.firmId,f.value.firmId]);await tx(()=>applyTargetingProposal(ctx(),{id:proposal.value.id,expectedRevision:1}));expect(await order()).toEqual([f.value.firmId,b.value.firmId]);
});
