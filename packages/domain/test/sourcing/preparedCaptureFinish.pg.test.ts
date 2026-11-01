import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {preparedSourceIdentityPgFixture} from './preparedSourceIdentityPgFixture.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {finishQualification} from '../../sourcing/qualificationStore.ts';
import {PREPARED_IDENTITY_PRODUCER} from '../../sourcing/preparedIdentity.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
import {lockDiscoveryReviewSources} from '../../sourcing/discoveryReviewVisibility.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestSourceCheck,runSourceCheck} from '../../sourcing/sourceCheck.ts';
import {researchPageFetch,type RawResponse} from '../../../../apps/worker/src/research/companyPageFetch.ts';
const response=(body:string,type='text/html'):RawResponse=>({statusCode:200,headers:{'content-type':type},body:new TextEncoder().encode(body),abortedOverCap:false});

it.each(['source','owner'] as const)('terminally drains actual prepared-identity producer after %s authority loss, conserving its paid attempt and fingerprint',async loss=>{
 const f=await preparedSourceIdentityPgFixture();
 try{
  const runId=await f.request(),before=await f.run(runId),final=new URL('https://www.'+new URL(f.website).host+'/management').href;
  expect(before.producer_version).toBe(PREPARED_IDENTITY_PRODUCER);
  let modelCalls=0;
  const pageFetch=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>input.url.endsWith('/robots.txt')?response('User-agent: *\nDisallow:\n','text/plain'):input.url===f.website?{statusCode:301,headers:{location:final},body:null,abortedOverCap:false}:response('<main><p>Our property management company manages residential homes and coordinates tenant maintenance requests.</p></main>')});
  await runQualification(f.worker,{runId},{pageFetch,extraction:{providerKey:'google_vertex.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>{modelCalls++;if(loss==='source')await withTransaction(f.runtime,()=>rememberExpiredManualSources(f.worker,[f.website]));else await f.deactivateOwner();return {ok:false,failureCode:'invalid_evidence',costCents:1};}}});
  expect(await f.run(runId)).toMatchObject({producer_version:PREPARED_IDENTITY_PRODUCER,state:'unavailable',reason:'source_unavailable',observations:[],facts:[],fingerprint:before.fingerprint});
  expect((await f.runtime.query('SELECT prepared_capture,prepared_identity,opening_question FROM sourcing_qualification_runs WHERE id=$1',[runId])).rows).toEqual([{prepared_capture:null,prepared_identity:null,opening_question:null}]);
  expect(modelCalls).toBe(1);expect((await f.runtime.query('SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1',[f.workspace])).rows).toEqual([{state:'settled',settled_cents:1}]);
 }finally{await f.drop();}
});

it.each(['facts','capture','positive','opening','user','scheduler'] as const)('does not use the failure drain to accept %s after prepared producer authority loss',async variant=>{
 const f=await preparedSourceIdentityPgFixture();
 try{
  const runId=await f.request();await f.deactivateOwner();
  const blocks=[{id:'identity',text:'Synthetic Harbor Property Management'}],observationId=randomUUID();
  const observation={id:observationId,url:f.website,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
  const context=variant==='user'?f.admin:variant==='scheduler'?repositoryContext(workspaceScope(f.workspace,{kind:'system',component:'scheduler'}),f.runtime):f.worker;
  const result=await withTransaction(f.runtime,()=>finishQualification(context,{runId,reason:variant==='positive'?null:'source_unavailable',observations:variant==='facts'?[observation]:[],facts:variant==='facts'?[{kind:'firm_identity',value:f.name,observationId,blockId:'identity'}]:[],...(variant==='capture'?{preparedCapture:{}}:{}),...(variant==='opening'?{openingQuestion:'Must not be stored'}:{})}));
  expect(result).toMatchObject({ok:false});expect(await f.run(runId)).toMatchObject({state:'pending',observations:[],facts:[]});
  expect((await f.runtime.query('SELECT count(*)::int n FROM provider_reservations WHERE workspace_id=$1',[f.workspace])).rows).toEqual([{n:0}]);
 }finally{await f.drop();}
});

it('uses fresh wall time after the v2 lifecycle wait before accepting a run deadline',async()=>{
 const f=await preparedSourceIdentityPgFixture();
 try{
  const runId=await f.request(),other=await f.database.appRuntimeSession(),otherCtx=repositoryContext(f.worker.scope,other);
  await f.runtime.query("UPDATE sourcing_qualification_runs SET deadline_at=clock_timestamp()+interval '200 milliseconds' WHERE id=$1",[runId]);
  const pid=(await f.runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  await other.query('BEGIN');await lockDiscoveryReviewSources(otherCtx);
  const finish=withTransaction(f.runtime,()=>finishQualification(f.worker,{runId,reason:'provider_error',observations:[],facts:[]}));
  try{await expect.poll(async()=>(await f.database.session.query<{waiting:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.waiting).toBe(true);await other.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM deadline_at-clock_timestamp()))+0.03) FROM sourcing_qualification_runs WHERE id=$1",[runId]);}finally{await other.query('COMMIT');}
  expect(await finish).toMatchObject({ok:false,reason:'qualification_expired'});expect(await f.run(runId)).toMatchObject({state:'unavailable',reason:'qualification_expired',observations:[],facts:[]});
 }finally{await f.drop();}
});
it('does not resurrect an in-flight grant after a matching intermediate source becomes unavailable then freshly pending',async()=>{
 const f=await preparedSourceIdentityPgFixture();
 try{
  const host='https://www.'+new URL(f.website).host,middle=host+'/redirect-entry',final=host+'/management';
  const aux=await withTransaction(f.runtime,()=>saveCandidate(f.admin,{firmName:'Auxiliary synthetic source authority',website:middle,sourceUrl:middle,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Fictional source check',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled fixture'}));if(!aux.ok)throw Error(aux.reason);
  const runId=await f.request(),before=await f.run(runId);let modelCalls=0;
  const pageFetch=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>input.url.endsWith('/robots.txt')?response('User-agent: *\nDisallow:\n','text/plain'):input.url===f.website?{statusCode:301,headers:{location:middle},body:null,abortedOverCap:false}:input.url===middle?{statusCode:302,headers:{location:final},body:null,abortedOverCap:false}:response('<main><p>Our property management team manages residential homes and coordinates tenant maintenance requests.</p></main>')});
  await runQualification(f.worker,{runId},{pageFetch,extraction:{providerKey:'google_vertex.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>{
   modelCalls++;
   expect(await withTransaction(f.runtime,()=>requestSourceCheck(f.admin,{id:aux.value.id,expectedRevision:1}))).toMatchObject({ok:true});
   const check=(await f.runtime.query<{check_id:string}>("SELECT source_check->>'checkId' check_id FROM sourcing_candidates WHERE id=$1",[aux.value.id])).rows[0]!.check_id;
   await withTransaction(f.runtime,()=>runSourceCheck(f.admin,{candidateId:aux.value.id,checkId:check},{providerKey:'controlled_readonly_pages',fetchPages:async()=>({ok:true,value:{pages:[],skipped:{}},costCents:0})}));
   expect((await f.runtime.query<{state:string}>("SELECT source_check->>'state' state FROM sourcing_candidates WHERE id=$1",[aux.value.id])).rows[0]!.state).toBe('unavailable');
   expect(await withTransaction(f.runtime,()=>requestSourceCheck(f.admin,{id:aux.value.id,expectedRevision:2}))).toMatchObject({ok:true});
   expect((await f.runtime.query<{state:string}>("SELECT source_check->>'state' state FROM sourcing_candidates WHERE id=$1",[aux.value.id])).rows[0]!.state).toBe('pending');
   return {ok:false,failureCode:'invalid_evidence',costCents:1};
  }}});
  expect(await f.run(runId)).toMatchObject({state:'unavailable',reason:'source_unavailable',observations:[],facts:[],fingerprint:before.fingerprint});
  expect((await f.runtime.query('SELECT prepared_capture FROM sourcing_qualification_runs WHERE id=$1',[runId])).rows).toEqual([{prepared_capture:null}]);
  expect(modelCalls).toBe(1);expect((await f.runtime.query('SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1',[f.workspace])).rows).toEqual([{state:'settled',settled_cents:1}]);
 }finally{await f.drop();}
});
