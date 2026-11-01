import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable,type QueryResultRowLike} from '../../db/queryable.ts';
import type {SourceObservation} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {readPreparedProspect} from '../../sourcing/preparedProspects.ts';
import {researchPageFetch,type RawResponse} from '../../../../apps/worker/src/research/companyPageFetch.ts';
import {readResearchSettings} from '../../research/settings.ts';
import {lockDiscoveryReviewSources} from '../../sourcing/discoveryReviewVisibility.ts';
import {databaseNow} from '../../policy/clock.ts';
import {preparedProspectsBusinessSnapshot} from './preparedProspectsPgFixture.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
import {deleteManualActivityEvidence} from '../../retention/manualActivityEvidenceDeletion.ts';
import {residentialFacts} from './support/modelSelections.ts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(session=runtime,worker=false)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,worker?{kind:'system',component:'worker'}:{kind:'user',role:'admin',userId:seed.alpha.admin.userId}),session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(runtime,fn);
const response=(body:string,type='text/html'):RawResponse=>({statusCode:200,headers:{'content-type':type},body:new TextEncoder().encode(body),abortedOverCap:false});
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await tx(async()=>{await lockDiscoveryReviewSources(ctx());await runtime.query('DELETE FROM sourcing_candidates');});await runtime.query('DELETE FROM evidence_items');await runtime.query('DELETE FROM provider_reservations');await runtime.query('DELETE FROM provider_ledger');await runtime.query('DELETE FROM research_settings');await runtime.query('DELETE FROM daily_counters');});
afterAll(async()=>db?.drop());

async function fixture(policy?:'legacy'|'prepared-source-association-v1'){
 const domain=`redirect-${randomUUID()}.example.test`,website=`https://${domain}/`,sourceUrl=website+'old-landing',middle=`https://www.${domain}/new-entry`,final=`https://www.${domain}/residential-management`;
 const saved=await tx(()=>saveCandidate(ctx(),{firmName:'Home | Fictional Management',website,sourceUrl,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Fictional search label only',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled redirect fixture'}));
 if(!saved.ok)throw Error(saved.reason);const candidateId=saved.value.id;
 await runtime.query('INSERT INTO research_settings(workspace_id,enabled,max_pages_per_firm) VALUES($1,true,1)',[seed.alpha.workspaceId]);
 let runId:string;
 if(policy){const now=await databaseNow(ctx()),settings=await readResearchSettings(ctx()),fingerprint=createHash('sha256').update(JSON.stringify([1,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION,settings.modelName,now.slice(0,10)])).digest('hex');
  runId=(await runtime.query<{id:string}>(`INSERT INTO sourcing_qualification_runs(workspace_id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version) VALUES($1,$2,1,$3,$4,$5,$6,$7) RETURNING id`,[seed.alpha.workspaceId,candidateId,fingerprint,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION,settings.modelName,policy])).rows[0]!.id;
 }else{const requested=await tx(()=>requestQualification(ctx(runtime,true),{candidateId,expectedRevision:1},{enqueue:false}));if(!requested.ok)throw Error(requested.reason);runId=requested.value.runId;}
 const target={candidateId,candidateRevision:1,runId};
 const stored=async()=>(await runtime.query<{fingerprint:string;producer_version:string;prompt_version:string;policy_version:string;model_name:string;prepared_capture:unknown}>('SELECT state,reason,capture_policy_version,prepared_capture,observations,facts,fingerprint,producer_version,prompt_version,policy_version,model_name FROM sourcing_qualification_runs WHERE id=$1',[runId])).rows[0]!;
 return {...target,target,website,sourceUrl,middle,final,stored};
}
async function capture(f:Awaited<ReturnType<typeof fixture>>,afterExtract:()=>Promise<void>=async()=>{}){
 const requests:string[]=[],inputs:string[]=[];
 const provider=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{requests.push(input.url);if(input.url.endsWith('/robots.txt'))return response('User-agent: *\nDisallow:\n','text/plain');if(input.url===f.sourceUrl)return {statusCode:301,headers:{location:f.middle},body:null,abortedOverCap:false};if(input.url===f.middle)return {statusCode:302,headers:{location:f.final},body:null,abortedOverCap:false};if(input.url===f.final)return response('<main><p>Our property management company manages residential homes for owners and coordinates tenant maintenance requests.</p></main>');return {statusCode:404,headers:{},body:null,abortedOverCap:false};}});
 await runQualification(ctx(runtime,true),f.target,{pageFetch:provider,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async input=>{inputs.push(JSON.stringify(input));return 100;},extract:async input=>{inputs.push(JSON.stringify(input));await afterExtract();return {ok:true,costCents:1,value:{facts:residentialFacts(input.observations),openingQuestion:null}};}}});
 return {requests,inputs};
}

it('carries actual adapter www/path redirects into a new versioned immutable grant used only by current prepared read',async()=>{
 const f=await fixture(),before=await f.stored(),calls=await capture(f),stored=await f.stored();
 expect(stored).toMatchObject({capture_policy_version:'prepared-source-association-v2',prepared_capture:{version:'prepared-source-association-v2',sourceUrl:f.sourceUrl,pages:[{url:f.final,redirectUrls:[f.sourceUrl,f.middle,f.final]}]}});
 expect(stored.fingerprint).toBe(before.fingerprint);expect(stored.producer_version).toBe(before.producer_version);expect(stored.prompt_version).toBe(before.prompt_version);expect(stored.policy_version).toBe(before.policy_version);expect(stored.model_name).toBe(before.model_name);
 expect(calls.requests).toEqual([f.website+'robots.txt',f.sourceUrl,new URL('/robots.txt',f.middle).href,f.middle,f.final]);
 expect(calls.inputs).toHaveLength(2);for(const value of calls.inputs)expect(value).not.toMatch(/redirectTrace|redirectUrls|prepared_capture|capture_policy_version/u);
 const accounting=await preparedProspectsBusinessSnapshot(ctx()),answer=await tx(()=>readPreparedProspect(ctx(),f.target));
 expect(answer).toMatchObject({ok:true,value:{state:'prepared',contactAuthority:'not_granted'}});expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(accounting);
 expect((await runtime.query('SELECT state,settled_cents FROM provider_reservations')).rows).toEqual([{state:'settled',settled_cents:1}]);
});

it.each(['legacy','prepared-source-association-v1'] as const)('does not rewrite or replay a same-day queued %s run to obtain a v2 grant',async policy=>{
 const f=await fixture(policy),before=await f.stored();expect(await tx(()=>requestQualification(ctx(runtime,true),{candidateId:f.candidateId,expectedRevision:1}))).toEqual({ok:true,value:{runId:f.runId}});await capture(f);
 expect(await f.stored()).toMatchObject({capture_policy_version:policy,prepared_capture:null,fingerprint:before.fingerprint,producer_version:before.producer_version,prompt_version:before.prompt_version,policy_version:before.policy_version,model_name:before.model_name});
 expect(await tx(()=>readPreparedProspect(ctx(),f.target))).toMatchObject({ok:true,value:{state:'needs_research',passages:[]}});
});

async function hopEvidence(f:Awaited<ReturnType<typeof fixture>>,expiresAt:Date|null=null){
 const firm=(await runtime.query<{id:string}>("INSERT INTO firms(workspace_id,name) VALUES($1,'Fictional hop source') RETURNING id",[seed.alpha.workspaceId])).rows[0]!.id;
 return (await runtime.query<{id:string}>('INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,\'fixture\',$3,$4,true,$5) RETURNING id',[seed.alpha.workspaceId,firm,f.middle,'a'.repeat(64),expiresAt])).rows[0]!.id;
}
it('binds validUntil to an intermediate hop and refuses after its wall-time expiry during authority waits',async()=>{
 const f=await fixture(),expires=Date.now()+1000;await hopEvidence(f,new Date(expires));await capture(f);
 expect(await tx(()=>readPreparedProspect(ctx(),f.target))).toMatchObject({ok:true,value:{validUntil:new Date(expires).toISOString()}});
 let calls=0;const result=await tx(()=>readPreparedProspect(ctx(),f.target,async()=>{if(++calls===2)await new Promise(resolve=>setTimeout(resolve,Math.max(0,expires-Date.now()+30)));return true;}));
 expect(result).toMatchObject({ok:false,reason:'source_expired'});expect(JSON.stringify(result)).not.toContain('maintenance requests');
});
it.each(['loss','delete','terms'] as const)('erases and refuses the manifest when an intermediate-hop %s wins during the final authority wait',async change=>{
 const f=await fixture();await capture(f);const evidence=await hopEvidence(f);let calls=0;
 const result=await tx(()=>readPreparedProspect(ctx(),f.target,async()=>{
  if(++calls===2){if(change==='loss')await rememberExpiredManualSources(ctx(runtime,true),[f.middle]);else if(change==='delete')await runtime.query('DELETE FROM evidence_items WHERE id=$1',[evidence]);else await runtime.query("UPDATE evidence_items SET terms_allow_retention=false,retention_expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",[evidence]);}return true;
 }));
 expect(result).toMatchObject({ok:false,reason:'source_changed'});expect((await f.stored()).prepared_capture).toBeNull();expect(JSON.stringify(result)).not.toContain('maintenance requests');
});
it('refuses source mutation without lifecycle custody instead of waiting in reverse evidence/run order',async()=>{
 const f=await fixture();await capture(f);const evidence=await hopEvidence(f);
 await expect(runtime.query('DELETE FROM evidence_items WHERE id=$1',[evidence])).rejects.toMatchObject({code:'40001'});
 expect((await f.stored()).prepared_capture).not.toBeNull();
});
it.each(['without_custody','with_custody'] as const)('fences an expired evidence URL move onto an intermediate dependency %s',async mode=>{
 const f=await fixture();await capture(f);
 const firm=(await runtime.query<{id:string}>("INSERT INTO firms(workspace_id,name) VALUES($1,'Fictional moved evidence') RETURNING id",[seed.alpha.workspaceId])).rows[0]!.id;
 const unrelated=f.website+'unrelated-expired-source';
 const evidence=(await runtime.query<{id:string}>(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at)
 VALUES($1,$2,'fixture',$3,$4,false,clock_timestamp()-interval '1 minute') RETURNING id`,[seed.alpha.workspaceId,firm,unrelated,'b'.repeat(64)])).rows[0]!.id;
 const before=(await f.stored()).prepared_capture;
 const move=()=>runtime.query('UPDATE evidence_items SET source_reference=$2 WHERE id=$1',[evidence,f.middle]);
 if(mode==='without_custody'){
  await expect(move()).rejects.toMatchObject({code:'40001'});
  expect((await f.stored()).prepared_capture).toEqual(before);
  expect((await runtime.query<{source_reference:string}>('SELECT source_reference FROM evidence_items WHERE id=$1',[evidence])).rows[0]!.source_reference).toBe(unrelated);
  expect(await tx(()=>readPreparedProspect(ctx(),f.target))).toMatchObject({ok:true,value:{state:'prepared'}});
 }else{
  await tx(async()=>{await lockDiscoveryReviewSources(ctx());await move();});
  expect((await f.stored()).prepared_capture).toBeNull();
  expect(await tx(()=>readPreparedProspect(ctx(),f.target))).toMatchObject({ok:true,value:{state:'needs_research',passages:[]}});
 }
});
it.each(['without_custody','with_custody'] as const)('serializes a future-TTL evidence insert onto a captured hop %s while leaving default-positive inserts unchanged',async mode=>{
 const f=await fixture();await capture(f);const before=(await f.stored()).prepared_capture;
 await hopEvidence(f);
 expect((await f.stored()).prepared_capture).toEqual(before);
 expect(await tx(()=>readPreparedProspect(ctx(),f.target))).toMatchObject({ok:true,value:{state:'prepared',validUntil:null}});
 const count=async()=>(await runtime.query<{n:number}>('SELECT count(*)::int n FROM evidence_items WHERE workspace_id=$1',[seed.alpha.workspaceId])).rows[0]!.n;
 const prior=await count(),insert=()=>hopEvidence(f,new Date(Date.now()+60_000));
 if(mode==='without_custody'){
  await expect(insert()).rejects.toMatchObject({code:'40001'});
  expect(await count()).toBe(prior);expect((await f.stored()).prepared_capture).toEqual(before);
  expect(await tx(()=>readPreparedProspect(ctx(),f.target))).toMatchObject({ok:true,value:{state:'prepared',validUntil:null}});
 }else{
  await tx(async()=>{await lockDiscoveryReviewSources(ctx());await insert();});
  expect(await count()).toBe(prior+1);expect((await f.stored()).prepared_capture).toBeNull();
  expect(await tx(()=>readPreparedProspect(ctx(),f.target))).toMatchObject({ok:true,value:{state:'needs_research',passages:[]}});
 }
});
it('rechecks current manifest and hop loss after a real source-lifecycle wait',async()=>{
 const f=await fixture();await capture(f);const other=await db.appRuntimeSession(),pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 await other.query('BEGIN');await lockDiscoveryReviewSources(ctx(other));
 const waiting=tx(()=>readPreparedProspect(ctx(),f.target));
 try{await expect.poll(async()=>(await db.session.query<{waiting:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.waiting).toBe(true);await rememberExpiredManualSources(ctx(other,true),[f.middle]);}finally{await other.query('COMMIT');}
 expect(await waiting).toMatchObject({ok:true,value:{state:'needs_research',passages:[]}});
 expect((await f.stored()).prepared_capture).toBeNull();
});
it.each(['loss','deletion'] as const)('finishes source-unavailable without replay when intermediate-hop %s commits before the first manifest exists',async change=>{
 const f=await fixture(),evidence=await hopEvidence(f),before=await f.stored(),other=await db.appRuntimeSession();
 const firm=(await runtime.query<{firm_id:string}>('SELECT firm_id FROM evidence_items WHERE id=$1',[evidence])).rows[0]!.firm_id;
 const pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 let held=false;
 const capturing=capture(f,async()=>{await other.query('BEGIN');await lockDiscoveryReviewSources(ctx(other));held=true;});
 try{
  await expect.poll(()=>held).toBe(true);
  await expect.poll(async()=>(await db.session.query<{waiting:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.waiting).toBe(true);
  // Finish must wait before its first candidate lock, not hold that row while
  // waiting for source lifecycle. The real deletion helper has no audit marker
  // for an optional intermediate source; the captured witness must detect it.
  await other.query('SELECT id FROM sourcing_candidates WHERE id=$1 FOR UPDATE NOWAIT',[f.candidateId]);
  if(change==='loss')await rememberExpiredManualSources(ctx(other,true),[f.middle]);
  else expect(await deleteManualActivityEvidence(ctx(other),{firmId:firm,contactId:null})).toBe(1);
 }finally{if(held)await other.query('COMMIT');}
 const calls=await capturing,after=await f.stored();
 expect(after).toMatchObject({state:'unavailable',reason:'source_unavailable',prepared_capture:null,observations:[],facts:[],fingerprint:before.fingerprint,producer_version:before.producer_version,prompt_version:before.prompt_version,policy_version:before.policy_version,model_name:before.model_name});
 expect(calls.inputs).toHaveLength(2);expect((await runtime.query('SELECT state,settled_cents FROM provider_reservations')).rows).toEqual([{state:'settled',settled_cents:1}]);
 expect(await tx(()=>readPreparedProspect(ctx(),f.target))).not.toMatchObject({ok:true,value:{state:'prepared'}});
});
it('locks the union of hop-group and exact-final evidence in global ID order before shared final-page evidence locks',async()=>{
 const f=await fixture();await capture(f);
 const source=(await runtime.query<{observations:SourceObservation[]}>('SELECT observations FROM sourcing_qualification_runs WHERE id=$1',[f.runId])).rows[0]!.observations[0]!;
 const middle=await hopEvidence(f),firm=(await runtime.query<{firm_id:string}>('SELECT firm_id FROM evidence_items WHERE id=$1',[middle])).rows[0]!.firm_id;
 const low='00000000-0000-4000-8000-000000000001',high='ffffffff-ffff-4fff-8fff-ffffffffffff';
 await tx(async()=>{await lockDiscoveryReviewSources(ctx());await runtime.query('UPDATE evidence_items SET id=$2 WHERE id=$1',[middle,low]);});
 // Updating a source erases its old manifest. This fixture only changes a PK,
 // which is outside source content/version fields and preserves the manifest.
 await runtime.query(`INSERT INTO evidence_items(workspace_id,id,firm_id,provider,source_reference,content_hash,retrieved_at,terms_allow_retention) VALUES($1,$2,$3,'fixture',$4,$5,$6,true)`,[seed.alpha.workspaceId,high,firm,f.final,source.contentHash,source.retrievedAt]);
 const locks:string[][]=[];
 const traced:SessionQueryable={query:async<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{const result=await runtime.query<Row>(sql,values);if(sql.includes('FROM evidence_items e')&&sql.includes('FOR SHARE OF e'))locks.push(result.rows.flatMap(r=>typeof r['id']==='string'?[r['id']]:[]));return result;}};
 const answer=await withTransaction(traced,()=>readPreparedProspect(ctx(traced),f.target));expect(answer).toMatchObject({ok:true,value:{state:'prepared'}});
 expect(locks[0]).toEqual([low,high]);expect(locks.slice(1)).toContainEqual([high]);
});
