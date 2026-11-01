import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {firmQualificationViewSchema,qualificationViewSchema,type QualificationFact,type SourceObservation} from '@fss/contracts';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {readFirmQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction,type Queryable,type QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {seedDiscoveryCandidate,type DiscoverySeed} from '@fss/domain/test/sourcing/support/discoverySeed.ts';
let f:AuthFixture,admin:string,sales:string,beta:string;
const envelope=<T extends object>(value:T)=>({...value,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function post(path:string,body:unknown,token=admin){return dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:localNoopSuppressionJournal()});}
beforeAll(async()=>{f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;});
afterAll(async()=>{await f.stop();});
async function linked(){
 const unique=randomUUID(),name=`Synthetic Native ${unique}`,website=`https://${unique}.example.test/`;
 const source={provider:'overture_places',release:'synthetic-fixture',recordId:unique,retrievedAt:null,sourceUrl:'https://example.test/source'};
 const seeded=await withTransaction(f.db,()=>seedDiscoveryCandidate(repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db),{row:{source,observations:[source],firmName:name,website,locality:'Dallas',region:'TX',sourceConfidence:null,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'unknown',probableGroupKey:null},origins:[{source,sourceMetadata:{sourcesJson:'[]'},licenses:['synthetic'],notices:[{label:'Fixture',url:'https://example.test/license',sha256:'a'.repeat(64)}]}]} as DiscoverySeed));
 const rawId=seeded.id;
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
it('zero-run Firm route exposes only current linkage and invokes the existing guarded first request idempotently',async()=>{
 const r=await linked();
 const before=(await f.db.query('SELECT id FROM jobs ORDER BY id')).rows;
 const answer=await read(r.firmId);expect(answer.status).toBe(200);
 expect(firmQualificationViewSchema.parse(answer.body)).toEqual({candidateId:r.candidateId,candidateRevision:1,status:'not_started',nativeEligibility:{status:'pending',reason:'evidence_pending',channelAuthority:'not_granted'}});
 expect((await f.db.query('SELECT id FROM jobs ORDER BY id')).rows).toEqual(before);
 expect((await f.db.query('SELECT id FROM sourcing_qualification_runs WHERE candidate_id=$1',[r.candidateId])).rows).toEqual([]);
 const input=envelope({candidateId:r.candidateId,expectedRevision:1});
 const request=await post('/sourcing/qualification/request',input);expect(request.body).toMatchObject({status:'accepted',result:{runId:expect.any(String)}});
 expect((await post('/sourcing/qualification/request',input)).body).toEqual({...request.body as object,replayed:true});
 expect((await post('/sourcing/qualification/request',envelope({candidateId:r.candidateId,expectedRevision:1}))).body).toMatchObject({status:'accepted',result:(request.body as {result:unknown}).result});
 expect((await f.db.query('SELECT id FROM sourcing_qualification_runs WHERE candidate_id=$1',[r.candidateId])).rows).toHaveLength(1);
 expect(qualificationViewSchema.parse((await read(r.firmId)).body)).toMatchObject({status:'pending',observations:[],facts:[],verdict:null,admission:null,nativeEligibility:{channelAuthority:'not_granted'}});
});
it('zero-run first request retains admin, revision, identity, disabled, hold and daily budget refusals',async()=>{
 const r=await linked(),request=(token=admin,expectedRevision=1)=>post('/sourcing/qualification/request',envelope({candidateId:r.candidateId,expectedRevision}),token);
 expect((await request(sales)).body).toMatchObject({reason:'admin_only'});
 expect((await request(admin,2)).body).toMatchObject({reason:'candidate_changed'});
 await f.db.query('UPDATE sourcing_candidates SET qualification_blocked=true WHERE id=$1',[r.candidateId]);
 expect((await request()).body).toMatchObject({reason:'identity_review_required'});
 await f.db.query('UPDATE sourcing_candidates SET qualification_blocked=false WHERE id=$1',[r.candidateId]);
 await f.db.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,false,1) ON CONFLICT(workspace_id) DO UPDATE SET enabled=false,daily_firm_ceiling=1',[f.alpha.workspaceId]);
 expect((await read(r.firmId)).status).toBe(200);expect((await request()).body).toMatchObject({reason:'research_disabled'});
 await f.db.query('UPDATE research_settings SET enabled=true WHERE workspace_id=$1',[f.alpha.workspaceId]);
 const hold=(await f.db.query<{id:string}>("INSERT INTO active_holds(workspace_id,scope_kind,reason_code,blocked_action_kinds,source_event_kind) VALUES($1,'workspace','scoped_pause',ARRAY['research'],'test') RETURNING id",[f.alpha.workspaceId])).rows[0]!;
 expect((await request()).body).toMatchObject({reason:'research_held'});
 await f.db.query('DELETE FROM active_holds WHERE id=$1',[hold.id]);
 await f.db.query('DELETE FROM daily_counters WHERE workspace_id=$1',[f.alpha.workspaceId]);
 const other=await linked();expect((await post('/sourcing/qualification/request',envelope({candidateId:other.candidateId,expectedRevision:1}))).body).toMatchObject({status:'accepted'});
 expect((await request()).body).toMatchObject({reason:'daily_firm_ceiling'});
 expect((await f.db.query('SELECT id FROM sourcing_qualification_runs WHERE candidate_id=$1',[r.candidateId])).rows).toEqual([]);
 await f.db.query('DELETE FROM research_settings WHERE workspace_id=$1',[f.alpha.workspaceId]);
});
it('zero-run response disappears for wrong owner/workspace, source loss and a changed linkage snapshot',async()=>{
 const r=await linked();expect((await read(r.firmId,sales)).status).toBe(404);expect((await read(r.firmId,beta)).status).toBe(404);
 expect(await readAcrossMutation(r.firmId,async()=>{await f.db.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1',[r.candidateId]);})).toBeNull();
 expect(firmQualificationViewSchema.parse((await read(r.firmId)).body)).toMatchObject({status:'not_started',candidateRevision:2});
 expect(await readAcrossMutation(r.firmId,async()=>{await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1',[r.firmId,f.alpha.salesperson.userId]);})).toBeNull();
 expect((await read(r.firmId)).status).toBe(404);
 const source=await linked();await f.db.query('DELETE FROM sourcing_candidate_discovery_origins WHERE candidate_id=$1',[source.rawId]);expect((await read(source.firmId)).status).toBe(404);
 const started=await linked();expect(await readAcrossMutation(started.firmId,async()=>{await run(started);})).toBeNull();
});
async function readAcrossMutation(firmId:string,mutate:()=>Promise<void>){
 let changed=false;
 const db:Queryable={async query<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[]){
  const result=await f.db.query<Row>(text,values);
  if(!changed&&text.includes('ORDER BY requested_at DESC,id DESC LIMIT 20')){changed=true;await mutate();}
  return result;
 }};
 const result=await readFirmQualification({db,scope:workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'})},firmId);
 expect(changed).toBe(true);return result;
}
function expectResolvedNativeCitations(body:unknown){
 const view=qualificationViewSchema.parse(body);expect(view.nativeEligibility?.status).toBe('verified');
 if(view.nativeEligibility?.status!=='verified')throw new Error('Expected current verified fixture');
 for(const citation of view.nativeEligibility.citations){
  const block=view.observations.find(source=>source.id===citation.observationId)?.blocks.find(row=>row.id===citation.blockId);
  expect(block).toBeDefined();expect(view.facts).toContainEqual(expect.objectContaining({...citation,value:block!.text}));
 }
}
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
 const r=await linked();expect((await read(r.firmId)).body).toMatchObject({status:'not_started',nativeEligibility:{status:'pending',channelAuthority:'not_granted'}});
 expect((await f.db.query('SELECT id FROM sourcing_qualification_runs WHERE candidate_id=$1',[r.candidateId])).rows).toEqual([]);
 await run(r,{age:7*86400000});expect((await read(r.firmId)).body).toMatchObject({nativeEligibility:{status:'unavailable'}});
});
it('fails closed on in-flight same-run completion rather than returning verified empty response evidence',async()=>{
 const r=await linked(),q=await run(r);
 await f.db.query("UPDATE sourcing_qualification_runs SET state='running',observations='[]'::jsonb,facts='[]'::jsonb WHERE id=$1",[q.runId]);
 const answer=await readAcrossMutation(r.firmId,async()=>{await f.db.query("UPDATE sourcing_qualification_runs SET state='review',observations=$2::jsonb,facts=$3::jsonb WHERE id=$1",[q.runId,JSON.stringify(q.observations),JSON.stringify(q.facts)]);});
 expect(answer).toBeNull();expectResolvedNativeCitations((await read(r.firmId)).body);
});
it.each(['pending','unavailable'])('fails closed on in-flight latest-run replacement with %s rather than mixing old evidence and new status',async state=>{
 const r=await linked();await run(r);let newest='';
 expect(await readAcrossMutation(r.firmId,async()=>{newest=(await run(r,{state,reason:state==='unavailable'?'source_unavailable':null})).runId;})).toBeNull();
 expect((await read(r.firmId)).body).toMatchObject({runId:newest,nativeEligibility:{status:state}});
});
