import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {authenticate,revokeDevice} from '../src/auth/sessions.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {seedRetainedRecovery} from '../../../packages/domain/test/sourcing/retainedRecoveryFixture.ts';
import {lockSendGateForStopFact} from '@fss/domain/policy/sendGate.ts';
import {retainedPrincipalAuthority} from '../src/routes/retainedPrincipalAuthority.ts';
let f:AuthFixture,observer:SessionQueryable,blocker:SessionQueryable;
const envelope=<T extends object>(body:T)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
const ctx=()=>repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db);
async function request(path:string,token:string,body:unknown){
 return await dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
async function blocked(pid:number){
 for(let i=0;i<200;i++){
  if((await observer.query<{waiting:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[pid])).rows[0]?.waiting)return;
  await delay(10);
 }
 throw Error('Expected request to reach actual PostgreSQL ownership lock wait');
}
const tables=['sourcing_candidates','sourcing_qualification_runs','sourcing_retained_identity_decisions','sourcing_retained_firm_acquisition_fences','firms','phone_routes','sourcing_admissions','audit_events','jobs','provider_reservations'];
async function snapshot(){const result:Record<string,unknown[]>={};for(const table of tables)result[table]=(await observer.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;return result;}
beforeAll(async()=>{f=await createAuthFixture();await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.salesperson.userId]);observer=await f.database.appRuntimeSession();blocker=await f.database.appRuntimeSession();});
afterAll(async()=>{await f.stop();});
for(const phase of ['identity','interpret','admit'] as const)for(const change of ['logout','device','expiry','membership'] as const){
 it(`${phase} refuses ${change} after actual ${change==='device'?'gate':'candidate'} lock wait with unchanged recovery/CRM rows`,async()=>{
  const clock=f.deps.now(),grant=await issueSessionFor(f,f.alpha,f.alpha.admin),token=grant.accessToken;
  const principal=await authenticate(f.deps,`Bearer ${token}`);if(!principal.authenticated)throw Error(principal.refusal);
  const original=await withTransaction(f.db,()=>seedRetainedRecovery(ctx(),randomUUID().slice(0,8)));
  let path='/sourcing/qualification/recovery/identity',command:object=envelope(original.identity);
  if(phase!=='identity'){
   const identity=await request(path,token,command);expect(identity.body).toMatchObject({status:'accepted'});
   const decisionId=(identity.body as {result:{decisionId:string}}).result.decisionId;
   path='/sourcing/qualification/recovery/interpret';command=envelope(original.interpretation(decisionId));
   if(phase==='admit'){
    const interpretation=await request(path,token,command);expect(interpretation.body).toMatchObject({status:'accepted'});
    path='/sourcing/qualification/admit';command=envelope({candidateId:original.candidateId,expectedRevision:2,qualificationRunId:(interpretation.body as {result:{runId:string}}).result.runId,mode:'reviewed'});
   }
  }
  const before=await snapshot(),pid=(await f.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await blocker.query('BEGIN');
  if(change==='device')await lockSendGateForStopFact(repositoryContext(ctx().scope,blocker));
  else await blocker.query('SELECT id FROM sourcing_candidates WHERE id=$1 FOR UPDATE',[original.candidateId]);
  const pending=request(path,token,command);
  try{
   await blocked(pid);
   if(change==='logout')await observer.query("UPDATE sessions SET status='ended',ended_at=$2,end_reason='signed_out' WHERE id=$1",[principal.principal.sessionId,f.deps.now().toISOString()]);
   else if(change==='device')await revokeDevice({...f.deps,db:observer},{workspaceId:f.alpha.workspaceId,deviceId:principal.principal.deviceId,reason:'device_revoked'});
   else if(change==='expiry')f.advance(3600001);
   else await observer.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);
  }finally{await blocker.query('ROLLBACK');}
  const answer=await pending;expect(answer.body).toMatchObject({status:'refused',reason:change==='membership'?(phase==='admit'?'identity_review_required':'admin_only'):'session_changed'});
  expect(await snapshot()).toEqual(before);
  expect((await observer.query('SELECT status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[f.alpha.workspaceId,f.alpha.admin.userId])).rows[0]).toEqual({status:'active'});
  f.setNow(clock);
  if(change==='expiry')expect((await request(path,token,command)).body).toMatchObject({status:'refused',replayed:true,reason:'session_changed'});
  if(change==='membership')await observer.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);
 });
}
it('holds exact device/session authority against revocation until transaction commit',async()=>{
 const grant=await issueSessionFor(f,f.alpha,f.alpha.admin),authorization=`Bearer ${grant.accessToken}`;
 const authenticated=await authenticate(f.deps,authorization);if(!authenticated.authenticated)throw Error(authenticated.refusal);
 const principal=authenticated.principal,request:ApiRequest={method:'POST',path:'/sourcing/qualification/recovery/identity',query:new URLSearchParams(),headers:{authorization},body:{}};
 await f.db.query('BEGIN');
 try{
  expect(await retainedPrincipalAuthority({auth:f.deps,principal,request},ctx())()).toBe(true);
  const revokerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const revoke=revokeDevice({...f.deps,db:blocker},{workspaceId:f.alpha.workspaceId,deviceId:principal.deviceId,reason:'device_revoked'});
  await blocked(revokerPid);
  await f.db.query('COMMIT');await revoke;
  expect((await authenticate(f.deps,authorization)).authenticated).toBe(false);
 }finally{await f.db.query('ROLLBACK');}
});
