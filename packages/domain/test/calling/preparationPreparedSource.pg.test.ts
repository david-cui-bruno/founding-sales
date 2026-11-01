import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {CallingPreparationInput,ManualPhoneChoice,ManualProspect} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {listManualProspects,recordManualProspectFeedback} from '../../sourcing/manualProspects.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
import {confirmCallingPreparation,readCallingPreparation,requireCurrentCallingPreparation} from '../../calling/preparation.ts';
import {sweepCallingPreparations} from '../../calling/preparationMaintenance.ts';
import {lockPreparationCleanup} from '../../calling/preparationLifecycle.ts';
import {readPreparedProjections} from '../../calling/preparationProjection.ts';
import {researchPageFetch,type RawResponse} from '../../../../apps/worker/src/research/companyPageFetch.ts';

// ADR0034: a phone kept from the prepared own-site pages is a Calling preparation source exactly like a phone-discovery run.
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(session=runtime,worker=false)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,worker?{kind:'system',component:'worker'}:{kind:'user',role:'admin',userId:seed.alpha.admin.userId}),session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(runtime,fn);
const response=(body:string):RawResponse=>({statusCode:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode(body),abortedOverCap:false});
const business='<p>Our property management company manages residential homes for owners and coordinates tenant maintenance requests.</p>';
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();
 await runtime.query('INSERT INTO research_settings(workspace_id,enabled,max_pages_per_firm) VALUES($1,true,1)',[seed.alpha.workspaceId]);});
afterAll(async()=>db?.drop());

const provider=(sourceUrl:string,middle:string,final:string,phone:string)=>researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{
 if(input.url.endsWith('/robots.txt'))return {statusCode:200,headers:{'content-type':'text/plain'},body:new TextEncoder().encode('User-agent: *\nDisallow:\n'),abortedOverCap:false};
 if(input.url===sourceUrl)return {statusCode:301,headers:{location:middle},body:null,abortedOverCap:false};
 if(input.url===middle)return {statusCode:302,headers:{location:final},body:null,abortedOverCap:false};
 if(input.url===final)return response(`<main>${business}<p>Office phone: ${phone}</p></main>`);
 return {statusCode:404,headers:{},body:null,abortedOverCap:false};
}});
const run=async(page:ReturnType<typeof provider>,candidateId:string)=>{
 const requested=await tx(()=>requestQualification(ctx(runtime,true),{candidateId,expectedRevision:1},{enqueue:false}));if(!requested.ok)throw Error(requested.reason);
 const target={candidateId,candidateRevision:1,runId:requested.value.runId};
 await runQualification(ctx(runtime,true),target,{pageFetch:page,extraction:{providerKey:'google_vertex.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>({ok:false,failureCode:'invalid_evidence',costCents:1})}});
 return requested.value.runId;
};
/** A real redirected own-site capture, a kept phone choice, and the reviewed Calling input. */
let serial=0;
const words=['Amber','Birch','Cedar','Delta','Ember','Fjord','Garnet','Harbor','Indigo','Juniper'];
async function keptPrepared(name=`${words[serial%10]}${words[Math.floor(serial/10)%10]} ${words[(serial++*7+3)%10]} Property Management`){
 const domain=`prepared-${randomUUID()}.example.test`,website=`https://${domain}/`,sourceUrl=website+'old-landing',middle=`https://www.${domain}/new-entry`,final=`https://www.${domain}/contact`;
 const saved=await tx(()=>saveCandidate(ctx(),{firmName:name,website,sourceUrl,locality:'Columbus',region:'OH',signal:'fit_only',evidence:'Fictional search label only',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled redirect fixture'}));
 if(!saved.ok)throw Error(saved.reason);
 const candidateId=saved.value.id,digits=String(3010+serial).slice(-4),phone=`(614) 725-${digits}`,runId=await run(provider(sourceUrl,middle,final,phone),candidateId);
 const answer=await tx(()=>listManualProspects(ctx(),{state:'all',offset:0,candidateId,expectedRevision:1,includeManualPhone:true}));if(!answer.ok)throw Error(answer.reason);
 const evidence=(answer.value.prospects.find(p=>p.candidateId===candidateId) as ManualProspect).phoneEvidence;
 if(evidence?.state!=='observed')throw Error('no prepared phone');
 const source=evidence.sources.find(item=>'method' in item&&item.normalizedValue!==null);if(!source||!('method' in source))throw Error('no prepared literal');
 const choice:ManualPhoneChoice={runId:source.runId,observationId:source.observationId,blockId:source.blockId,labelStart:source.labelStart,labelEnd:source.labelEnd,start:source.start,end:source.end,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash};
 const kept=await tx(()=>recordManualProspectFeedback(ctx(),{candidateId,expectedRevision:1,state:'kept',phoneChoice:choice}));if(!kept.ok)throw Error(kept.reason);
 const input:CallingPreparationInput={selection:{candidateId,expectedCandidateRevision:1,choice},expected:{state:'absent'},reviewedProfile:{companyName:name,website,
  addressLine:'10 Fictional Office Way',locality:'Columbus',regionCode:'OH',postalCode:'43004',countryCode:'US',timeZone:{kind:'reviewed',timeZone:'America/New_York'}},acknowledgeUnqualifiedSourceOwnership:true};
 return {candidateId,runId,choice,input,website,sourceUrl,middle,final,e164:`+1614725${digits}`};
}
const save=async(f:Awaited<ReturnType<typeof keptPrepared>>)=>{const a=await tx(()=>confirmCallingPreparation(ctx(),f.input,async()=>true));if(!a.ok)throw Error(a.reason);return a.value;};
const row=async(id:string)=>(await runtime.query<Record<string,unknown>>('SELECT * FROM calling_preparations WHERE id=$1',[id])).rows[0]!;
const erased=async(id:string)=>{const r=await row(id);return {state:r['state'],reason:r['erase_reason'],choice:r['choice'],hashes:r['source_url_hashes']};};
const nothingPlaced=async()=>(await runtime.query<{n:number}>('SELECT (SELECT count(*) FROM dial_tickets)::int+(SELECT count(*) FROM phone_handoff_attempts)::int+(SELECT count(*) FROM provider_reservations)::int+(SELECT count(*) FROM jobs)::int AS n')).rows[0]!.n;

it('saves a company from a prepared own-site phone with no phone-discovery run, bound to the exact capture, without placing or reserving a call',async()=>{
 const f=await keptPrepared(),before=await nothingPlaced();
 const preview=await tx(()=>readCallingPreparation(ctx(),f.input.selection,async()=>true));
 expect(preview).toMatchObject({state:'available',binding:null,phone:{value:f.e164},contactAuthority:'not_granted'});
 const saved=await save(f),p=await row(saved.preparationId);
 expect(p).toMatchObject({source_kind:'prepared_capture',discovery_run_ref:f.runId,source_creator_ref:seed.alpha.admin.userId,prepared_by_ref:seed.alpha.admin.userId,state:'live'});
 expect((await runtime.query('SELECT 1 FROM sourcing_prospect_phone_discoveries WHERE candidate_id=$1',[f.candidateId])).rows).toEqual([]);
 // Every URL whose loss must withdraw the company: website, candidate source, and each capture hop through the cited page.
 const hashes=new Set(p['source_url_hashes'] as string[]),sha=async(u:string)=>(await runtime.query<{h:string}>("SELECT encode(sha256(convert_to($1,'UTF8')),'hex') h",[u.replace(/\/+$/u,'')])).rows[0]!.h;
 for(const url of [f.website,f.sourceUrl,f.middle,f.final])expect(hashes.has(await sha(url))).toBe(true);
 expect((await runtime.query('SELECT e164,source,eligibility FROM phone_routes WHERE id=$1',[saved.routeId])).rows).toEqual([{e164:f.e164,source:'website',eligibility:'candidate'}]);
 expect(await tx(()=>readCallingPreparation(ctx(),f.input.selection,async()=>true))).toMatchObject({state:'available',binding:{preparationId:saved.preparationId}});
 await tx(async()=>{await lockPreparationCleanup(ctx());await requireCurrentCallingPreparation(ctx(),saved.firmId,async()=>true);});
 // Nonlocking projection (ordinary CRM reads) keeps it current without lifecycle custody, via the preparer's authority.
 const projection=await tx(()=>readPreparedProjections(ctx(),[saved.firmId]));
 expect(projection.get(saved.firmId)).toMatchObject({current:true});
 expect(await nothingPlaced()).toBe(before);
});
it('refuses a second company for the same candidate and a proposed choice that is not the stored one',async()=>{
 const f=await keptPrepared();await save(f);
 expect(await tx(()=>confirmCallingPreparation(ctx(),f.input,async()=>true))).toMatchObject({ok:false,reason:'preparation_version_conflict'});
 const other={...f.input,selection:{...f.input.selection,choice:{...f.choice,contentHash:'b'.repeat(64)}}};
 expect(await tx(()=>confirmCallingPreparation(ctx(),other,async()=>true))).toMatchObject({ok:false});
});
it('rejects a prepared preparation whose chosen observation the run does not hold, and an immutable source kind',async()=>{
 const f=await keptPrepared(),saved=await save(f);
 await expect(tx(()=>runtime.query("UPDATE calling_preparations SET source_kind='phone_discovery' WHERE id=$1",[saved.preparationId]))).rejects.toMatchObject({code:'23514'});
 // The loss trigger is bypassed as table owner; the deferred consistency assertion alone must refuse the swapped observation.
 await expect(withTransaction(db.session,async()=>{
  await db.session.query('ALTER TABLE sourcing_qualification_runs DISABLE TRIGGER calling_preparation_prepared_run_source');
  await db.session.query("UPDATE sourcing_qualification_runs SET observations=jsonb_set(observations,'{0,id}',to_jsonb(gen_random_uuid()::text)) WHERE id=$1",[f.runId]);
  await db.session.query('UPDATE firms SET updated_at=clock_timestamp() WHERE id=$1',[saved.firmId]);
 })).rejects.toMatchObject({code:'23514',message:/exact current source/u});
});
it('withdraws and physically erases the company when its own-site page source is lost',async()=>{
 const f=await keptPrepared(),saved=await save(f);
 await tx(async()=>{await lockPreparationCleanup(ctx());await rememberExpiredManualSources(ctx(runtime,true),[f.final]);});
 expect(await erased(saved.preparationId)).toMatchObject({state:'erased',choice:null,hashes:null});
 expect((await runtime.query('SELECT name,website FROM firms WHERE id=$1',[saved.firmId])).rows).toEqual([{name:'[source unavailable company]',website:null}]);
 expect((await runtime.query('SELECT e164,eligibility FROM phone_routes WHERE id=$1',[saved.routeId])).rows).toEqual([{e164:null,eligibility:'retired'}]);
 expect(await tx(()=>readCallingPreparation(ctx(),f.input.selection,async()=>true))).toMatchObject({state:'withdrawn',preparationId:saved.preparationId});
});
it('erases on a lost capture hop, a cleared run observation, an expired source and a withdrawn manual choice',async()=>{
 // A middle redirect hop is lost: the capture manifest depends on it, so the company is withdrawn with it.
 const hop=await keptPrepared(),savedHop=await save(hop);
 await tx(async()=>{await lockPreparationCleanup(ctx());await rememberExpiredManualSources(ctx(runtime,true),[hop.middle]);});
 expect(await erased(savedHop.preparationId)).toMatchObject({state:'erased'});
 // The run row itself cleared of its observation.
 const cleared=await keptPrepared(),savedCleared=await save(cleared);
 await tx(async()=>{await lockPreparationCleanup(ctx());await runtime.query("UPDATE sourcing_qualification_runs SET observations='[]'::jsonb,prepared_capture=NULL WHERE id=$1",[cleared.runId]);});
 expect(await erased(savedCleared.preparationId)).toMatchObject({state:'erased',reason:'source_changed'});
 // Source deadline passes (cleanup sweep).
 const expiring=await keptPrepared(),savedExpiring=await save(expiring);
 await db.session.query('ALTER TABLE calling_preparations DISABLE TRIGGER USER');
 await db.session.query("UPDATE calling_preparations SET source_expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[savedExpiring.preparationId]);
 await db.session.query('ALTER TABLE calling_preparations ENABLE TRIGGER USER');
 await new Promise(resolve=>setTimeout(resolve,400));
 await tx(()=>sweepCallingPreparations(ctx(),{limit:10}));
 expect(await erased(savedExpiring.preparationId)).toMatchObject({state:'erased',reason:'source_expired'});
 // The kept choice is withdrawn (manual feedback), like a discovery-run choice.
 const dismissed=await keptPrepared(),savedDismissed=await save(dismissed);
 const dropped=await tx(()=>recordManualProspectFeedback(ctx(),{candidateId:dismissed.candidateId,expectedRevision:1,state:'kept',phoneChoice:null}));
 expect(dropped).toMatchObject({ok:true});
 expect(await erased(savedDismissed.preparationId)).toMatchObject({state:'erased'});
});
it('withdraws a prepared-source company once a newer qualification run supersedes it: current reads refuse it and cleanup erases it',async()=>{
 const f=await keptPrepared(),saved=await save(f);
 // A later run for the same candidate (a re-run) becomes the latest; the choice names the earlier one.
 await runtime.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version)
  VALUES($1,$2,$3,1,repeat('b',64),'qualification-context-v7','qualification-v5','claude-haiku-4-5','prepared-source-association-v2')`,[seed.alpha.workspaceId,randomUUID(),f.candidateId]);
 expect(await tx(()=>readCallingPreparation(ctx(),f.input.selection,async()=>true))).toMatchObject({state:'withdrawn',preparationId:saved.preparationId});
 expect((await tx(()=>readPreparedProjections(ctx(),[saved.firmId]))).get(saved.firmId)).toMatchObject({current:false});
 await expect(tx(async()=>{await lockPreparationCleanup(ctx());await requireCurrentCallingPreparation(ctx(),saved.firmId,async()=>true);})).rejects.toMatchObject({reason:'source_withdrawn'});
 expect(await tx(()=>sweepCallingPreparations(ctx(),{limit:10}))).toBeGreaterThanOrEqual(1);
 expect(await erased(saved.preparationId)).toMatchObject({state:'erased',reason:'source_changed'});
});
it('refuses to save against an in-flight run, and finishing that run neither fails nor is blocked by the loss guard',async()=>{
 const website=`https://flight-${randomUUID()}.example.test/`,name='Zephyr Quartz Property Management';
 const saved=await tx(()=>saveCandidate(ctx(),{firmName:name,website,sourceUrl:website,locality:'Columbus',region:'OH',signal:'fit_only',evidence:'Fictional search label only',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Fixture'}));
 if(!saved.ok)throw Error(saved.reason);const candidateId=saved.value.id;
 const requested=await tx(()=>requestQualification(ctx(runtime,true),{candidateId,expectedRevision:1},{enqueue:false}));if(!requested.ok)throw Error(requested.reason);
 const blocks=[{id:'b1',text:'Office phone: (614) 725-4411'},{id:'b2',text:'Our property management company manages residential homes for owners and coordinates tenant maintenance requests.'}];
 const page={id:randomUUID(),url:website,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(Date.now()-60_000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 // Observations are committed before extraction, so the run is still running while its page is already readable.
 await runtime.query("UPDATE sourcing_qualification_runs SET state='running',observations=$3::jsonb WHERE workspace_id=$1 AND id=$2",[seed.alpha.workspaceId,requested.value.runId,JSON.stringify([page])]);
 const answer=await tx(()=>listManualProspects(ctx(),{state:'all',offset:0,candidateId,expectedRevision:1,includeManualPhone:true}));if(!answer.ok)throw Error(answer.reason);
 const evidence=answer.value.prospects.find(p=>p.candidateId===candidateId)?.phoneEvidence;if(evidence?.state!=='observed')throw Error('phone not offered');
 const source=evidence.sources.find(item=>'method' in item&&item.normalizedValue!==null);if(!source||!('method' in source))throw Error('no literal');
 const choice:ManualPhoneChoice={runId:source.runId,observationId:source.observationId,blockId:source.blockId,labelStart:source.labelStart,labelEnd:source.labelEnd,start:source.start,end:source.end,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash};
 expect(await tx(()=>recordManualProspectFeedback(ctx(),{candidateId,expectedRevision:1,state:'kept',phoneChoice:choice}))).toMatchObject({ok:true});
 const input:CallingPreparationInput={selection:{candidateId,expectedCandidateRevision:1,choice},expected:{state:'absent'},reviewedProfile:{companyName:name,website,
  addressLine:'10 Fictional Office Way',locality:'Columbus',regionCode:'OH',postalCode:'43004',countryCode:'US',timeZone:{kind:'reviewed',timeZone:'America/New_York'}},acknowledgeUnqualifiedSourceOwnership:true};
 expect(await tx(()=>confirmCallingPreparation(ctx(),input,async()=>true))).toMatchObject({ok:false,reason:'source_withdrawn'});
 expect(await tx(()=>readCallingPreparation(ctx(),input.selection,async()=>true))).toMatchObject({state:'refused',reason:'source_withdrawn'});
 expect((await runtime.query('SELECT 1 FROM calling_preparations WHERE candidate_ref=$1',[candidateId])).rows).toEqual([]);
 // Completion holds only the source lifecycle lock; with no bound preparation the loss guard cannot raise 40001.
 await tx(async()=>{await runtime.query("UPDATE sourcing_qualification_runs SET state='review' WHERE workspace_id=$1 AND id=$2",[seed.alpha.workspaceId,requested.value.runId]);});
 const done=await tx(()=>confirmCallingPreparation(ctx(),input,async()=>true));
 expect(done).toMatchObject({ok:true});
});
it('refuses to save when a dependency the capture rests on was already lost, such as the website root, and caps expiry by the earliest dependency deadline',async()=>{
 const f=await keptPrepared();
 await tx(async()=>{await lockPreparationCleanup(ctx());await rememberExpiredManualSources(ctx(runtime,true),[f.website]);});
 expect(await tx(()=>confirmCallingPreparation(ctx(),f.input,async()=>true))).toMatchObject({ok:false,reason:'source_withdrawn'});
 expect((await runtime.query('SELECT 1 FROM calling_preparations WHERE candidate_ref=$1',[f.candidateId])).rows).toEqual([]);
 const capped=await keptPrepared(),soon=new Date(Date.now()+90_000);
 const firm=(await runtime.query<{id:string}>("INSERT INTO firms(workspace_id,name) VALUES($1,'Fictional deadline holder') RETURNING id",[seed.alpha.workspaceId])).rows[0]!.id;
 await tx(async()=>{await lockPreparationCleanup(ctx());await runtime.query("INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'fixture',$3,$4,true,$5)",[seed.alpha.workspaceId,firm,capped.website,'c'.repeat(64),soon]);});
 const saved=await save(capped);
 const expires=((await row(saved.preparationId))['source_expires_at'] as Date).getTime();
 expect(expires).toBeLessThanOrEqual(soon.getTime());expect(expires).toBeGreaterThan(Date.now());
});
