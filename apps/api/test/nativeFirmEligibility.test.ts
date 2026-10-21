import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {qualificationViewSchema,type QualificationFact,type SourceObservation} from '@fss/contracts';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let f:AuthFixture,admin:string,sales:string,beta:string;
const envelope=<T extends object>(value:T)=>({...value,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function post(path:string,body:unknown,token=admin){return dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:localNoopSuppressionJournal()});}
beforeAll(async()=>{f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;});
afterAll(async()=>{await f.stop();});
async function linked(){
 const unique=randomUUID(),name=`Synthetic Native ${unique}`,website=`https://${unique}.example.test/`;
 const source={provider:'overture_places',release:'synthetic-fixture',recordId:unique,retrievedAt:null,sourceUrl:'https://example.test/source'};
 const saved=await post('/sourcing/candidates/discovery/save-v1',envelope({row:{source,observations:[source],firmName:name,website,locality:'Dallas',region:'TX',sourceConfidence:null,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'unknown',probableGroupKey:null},origins:[{source,sourceMetadata:{sourcesJson:'[]'},licenses:['synthetic'],notices:[{label:'Fixture',url:'https://example.test/license',sha256:'a'.repeat(64)}]}]}));expect(saved.body).toMatchObject({status:'accepted'});
 const rawId=(saved.body as {result:{id:string}}).result.id;
 const prepared=await post('/sourcing/candidates/discovery/prepare-v1',envelope({discoveryCandidateId:rawId,expectedRevision:1,source:{provider:source.provider,release:source.release,recordId:unique},candidate:{firmName:name,website,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Synthetic fixture, never real qualification.',sourceUrl:website,observedOn:'2026-10-21',preparedBy:'Controlled test'}}));expect(prepared.body).toMatchObject({status:'accepted'});
 const candidateId=(prepared.body as {result:{qualificationCandidateId:string}}).result.qualificationCandidateId;
 const made=await post('/crm/firms/add',envelope({firm:{name,website}}));expect(made.body).toMatchObject({status:'accepted'});const firmId=(made.body as {result:{firmId:string}}).result.firmId;
 expect((await post('/sourcing/candidates/discovery/link-research-firm-v1',envelope({discoveryCandidateId:rawId,expectedRevision:1,qualificationCandidateId:candidateId,firmId}))).body).toMatchObject({status:'accepted'});
 return {rawId,candidateId,firmId,name,website};
}
/** Disposable synthetic run rows ONLY. No qualification request, worker or provider.
 * These are not retained Tree evidence or real/native quality acceptance. */
async function run(r:Awaited<ReturnType<typeof linked>>,changes:{state?:string;reason?:string|null;revision?:number;prompt?:string;policy?:string;age?:number;full?:boolean}={}){
 const runId=randomUUID(),now=(await f.db.query<{now:Date}>('SELECT now() AS now')).rows[0]!.now;
 const text=`${r.name} provides residential property management in Dallas, TX.`;
 const observations:SourceObservation[]=[{id:randomUUID(),url:r.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date(now.getTime()-(changes.age??0)).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'native',text}]}];
 const facts:QualificationFact[]=(['firm_identity','service_area','residential_management'] as const).map(kind=>({kind,value:changes.full===false&&kind==='firm_identity'?r.name:text,observationId:observations[0]!.id,blockId:'native'}));
 await f.db.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,state,reason,observations,facts,requested_at) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-no-provider',$8,$9,$10::jsonb,$11::jsonb,clock_timestamp())`,[f.alpha.workspaceId,runId,r.candidateId,changes.revision??1,createHash('sha256').update(randomUUID()).digest('hex'),changes.prompt??'qualification-context-v7',changes.policy??'qualification-v5',changes.state??'review',changes.reason??null,JSON.stringify(observations),JSON.stringify(facts)]);
 return {runId,observations,facts};
}
const read=async(firmId:string,token=admin)=>post('/sourcing/qualification/firm',{firmId},token);
it('reads exact current native evidence on existing owner Firm without phone/location writes, jobs or cache changes',async()=>{
 const r=await linked(),q=await run(r);
 const counts=async()=>({jobs:(await f.db.query('SELECT id,kind,payload FROM jobs ORDER BY id')).rows,firms:(await f.db.query('SELECT id,locality,region_code,time_zone FROM firms ORDER BY id')).rows,runs:(await f.db.query('SELECT * FROM sourcing_qualification_runs ORDER BY id')).rows});
 const before=await counts(),answer=await read(r.firmId);expect(answer.status).toBe(200);
 const view=qualificationViewSchema.parse(answer.body);expect(view).toMatchObject({candidateId:r.candidateId,runId:q.runId,admission:null,nativeEligibility:{status:'verified',firmId:r.firmId,ownerUserId:f.alpha.admin.userId,channelAuthority:'not_granted',citations:expect.arrayContaining([expect.objectContaining({kind:'service_area'})])}});
 expect(await counts()).toEqual(before);
 expect((await f.db.query('SELECT count(*)::int AS n FROM phone_routes WHERE firm_id=$1',[r.firmId])).rows[0]).toEqual({n:0});
 const today=await dispatch({method:'GET',path:'/today',body:undefined,query:new URLSearchParams(),headers:{authorization:`Bearer ${admin}`}} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false});
 expect(today.body).toMatchObject({cards:expect.arrayContaining([expect.objectContaining({firmId:r.firmId,lane:'new_firm'})])});expect(JSON.stringify(today.body)).not.toContain('nativeEligibility');
});
it('uses newest current run, never an older success, and accepts legitimate source-check revision advancement',async()=>{
 const r=await linked();await run(r);await f.db.query('UPDATE sourcing_candidates SET revision=2 WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,r.candidateId]);
 const q=await run(r,{revision:2});expect((await read(r.firmId)).body).toMatchObject({nativeEligibility:{status:'verified',runId:q.runId,candidateRevision:2}});
 await run(r,{revision:2,state:'pending'});expect((await read(r.firmId)).body).toMatchObject({nativeEligibility:{status:'pending',reason:'latest_run_pending'}});
 await run(r,{revision:2,state:'unavailable',reason:'source_unavailable'});expect((await read(r.firmId)).body).toMatchObject({nativeEligibility:{status:'unavailable',reason:'latest_run_unavailable'}});
});
it.each([{prompt:'old'},{policy:'old'},{revision:9},{age:8*86400000},{full:false}])('rejects incompatible current metadata or evidence %j',async edit=>{
 const r=await linked();await run(r);await run(r,edit);expect((await read(r.firmId)).body).toMatchObject({nativeEligibility:{status:'unavailable'}});
});
it('requires current admin owner/membership and refuses corrections, geography conflicts and source loss',async()=>{
 const r=await linked();await run(r);expect((await read(r.firmId,sales)).status).toBe(404);expect((await read(r.firmId,beta)).status).toBe(404);
 await f.db.query('UPDATE sourcing_candidates SET qualification_blocked=true WHERE id=$1',[r.candidateId]);expect((await read(r.firmId)).body).toMatchObject({nativeEligibility:{status:'unavailable',reason:'identity_unresolved'}});
 await f.db.query('UPDATE sourcing_candidates SET qualification_blocked=false WHERE id=$1',[r.candidateId]);
 await f.db.query("UPDATE firms SET locality='Austin',region_code='TX' WHERE id=$1",[r.firmId]);expect((await read(r.firmId)).body).toMatchObject({nativeEligibility:{status:'unavailable',reason:'lineage_changed'}});
 await f.db.query('UPDATE firms SET locality=null,region_code=null,assigned_user_id=$2 WHERE id=$1',[r.firmId,f.alpha.salesperson.userId]);expect((await read(r.firmId)).status).toBe(404);
 await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1',[r.firmId,f.alpha.admin.userId]);
 await f.db.query('DELETE FROM sourcing_candidate_discovery_origins WHERE candidate_id=$1',[r.rawId]);expect((await read(r.firmId)).status).toBe(404);
 expect((await f.db.query('SELECT id FROM firms WHERE id=$1',[r.firmId])).rows).toHaveLength(1);
});
it('keeps missing and expired evidence unverified without creating any new run',async()=>{
 const r=await linked();expect((await read(r.firmId)).status).toBe(404);
 await run(r,{age:7*86400000});expect((await read(r.firmId)).body).toMatchObject({nativeEligibility:{status:'unavailable'}});
});
