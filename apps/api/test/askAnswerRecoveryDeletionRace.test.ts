import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import type {SessionQueryable,QueryResultRowLike,QueryOutcome} from '@fss/domain/db/queryable.ts';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

it('conserves reclaimed unknown Ask charges while public deletion erases private input without a monthly/request deadlock',async()=>{
 const fixture=await createAuthFixture();
 let releaseProvider:()=>void=()=>{},releaseRecovery:()=>void=()=>{};
 let original:ReturnType<typeof runOnce>|undefined,recovery:ReturnType<typeof runOnce>|undefined,deletion:ReturnType<typeof dispatch>|undefined;
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  const post=(session:SessionQueryable,path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session,auth:{...fixture.deps,db:session},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
  const firmId=await seedFirm(fixture,{name:'Recovery deletion race',assignedUserId:fixture.alpha.admin.userId});
  const text='Maintenance routing needs a coordinator.';
  const selection={text,subtype:'pasted_text',label:'Controlled race source',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post(fixture.db,'/crm/imports/preview',selection);expect(preview.status).toBe(200);
  const imported=await post(fixture.db,'/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'}));expect(imported.status).toBe(200);
  const sourceId=(imported.body as {result:{sourceId:string}}).result.sourceId;
  await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-ask-only','fixture-no-retention',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1,1,$3)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
  const requested=await post(fixture.db,'/ask/answers/request',command({question:'maintenance routing',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null}]}}));expect(requested.status,JSON.stringify(requested.body)).toBe(200);
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  let providerEntered:()=>void=()=>{};
  const entered=new Promise<void>(resolve=>{providerEntered=resolve;}),held=new Promise<void>(resolve=>{releaseProvider=resolve;});
  let calls=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'}),answer:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer',run:async()=>{calls++;providerEntered();await held;return {acceptance:'unknown',usage:null,answer:null};}}}});
  const first=await fixture.database.appRuntimeSession(),recoverySession=await fixture.database.appRuntimeSession(),deletionSession=await fixture.database.appRuntimeSession();
  original=runOnce(first,{registry,owner:'ask-race-original',limit:20});
  await Promise.race([entered,original.then(()=>{throw new Error('paid_wait_not_reached');})]);
  const reserved=(await fixture.db.query<{cents:number;state:string}>("SELECT cents,state FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='crm_ask_answer' AND subject_id=$2",[fixture.alpha.workspaceId,requestId])).rows[0]!;expect(reserved).toMatchObject({state:'calling'});expect(reserved.cents).toBeGreaterThan(0);
  let shown=await post(fixture.db,'/retention/deletions/preview',command({targetKind:'firm',firmId}));expect(shown.status).toBe(200);
  await fixture.db.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND kind='crm.ask_answer' AND payload->>'requestId'=$2 AND state='running'",[fixture.alpha.workspaceId,requestId]);
  let acquired:()=>void=()=>{};
  const acquiredRequest=new Promise<void>(resolve=>{acquired=resolve;}),paused=new Promise<void>(resolve=>{releaseRecovery=resolve;});
  let once=true;
  const gatedRecovery:SessionQueryable={async query<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[]):Promise<QueryOutcome<Row>>{
   const result=await recoverySession.query<Row>(sql,values);
   if(once&&sql==='SELECT id FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE'){once=false;acquired();await paused;}
   return result;
  }};
  const recoveryPid=(await recoverySession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const deletionPid=(await deletionSession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  recovery=runOnce(gatedRecovery,{registry,owner:'ask-race-recovery',limit:20});
  await Promise.race([acquiredRequest,recovery.then(()=>{throw new Error('recovery_request_lock_not_reached');})]);
  const approval=(shown.body as {result:{requestId:string;previewHash:string}}).result;
  deletion=post(deletionSession,'/retention/deletions/commit',command({requestId:approval.requestId,previewHash:approval.previewHash}));
  let blocked=false;
  for(let attempt=0;attempt<200;attempt++){
   blocked=(await fixture.db.query<{blocked:boolean}>('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[deletionPid,recoveryPid])).rows[0]!.blocked;
   if(blocked)break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  if(!blocked){releaseRecovery();throw new Error('deletion_not_blocked:'+JSON.stringify(await deletion));}
  releaseRecovery();
  const [recovered,firstDeletion]=await Promise.all([recovery,deletion]);
  expect(recovered).toMatchObject({reclaimed:1,failed:0,completed:1});
  let committed=firstDeletion;
  // A recovery changes the exact preview state. A fresh public preview is the only permitted retry.
  if(committed.status!==200){
   expect(committed.body).toMatchObject({status:'refused',reason:'preview_stale'});
   shown=await post(fixture.db,'/retention/deletions/preview',command({targetKind:'firm',firmId}));expect(shown.status).toBe(200);
   const fresh=(shown.body as {result:{requestId:string;previewHash:string}}).result;
   committed=await post(fixture.db,'/retention/deletions/commit',command({requestId:fresh.requestId,previewHash:fresh.previewHash}));
  }
  expect(committed.status,JSON.stringify(committed.body)).toBe(200);
  expect((await post(fixture.db,'/ask/answers/read',{requestId})).body).toMatchObject({state:'deleted',question:null,fallback:null,answer:null});
  expect((await fixture.db.query<{state:string;settled_cents:number}>("SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='crm_ask_answer' AND subject_id=$2",[fixture.alpha.workspaceId,requestId])).rows).toEqual([{state:'estimated',settled_cents:reserved.cents}]);
  expect((await fixture.db.query<{dispatch_state:string}>('SELECT dispatch_state FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND request_id=$2',[fixture.alpha.workspaceId,requestId])).rows).toEqual([{dispatch_state:'unknown_acceptance'}]);
  expect((await fixture.db.query<{count:string}>('SELECT count(*) AS count FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id=$2',[fixture.alpha.workspaceId,requestId])).rows[0]!.count).toBe('0');
  expect(calls).toBe(1);
 }finally{releaseRecovery();releaseProvider();await Promise.allSettled([original,recovery,deletion]);await fixture.stop();}
});
