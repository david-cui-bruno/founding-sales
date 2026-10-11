import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import type {AskAnswerComposition,AskAgentStepAdapter} from '@fss/domain/crm/askAnswerPorts.ts';
it.each([false,true])('erases source-free transitive followup history during a paid model wait, including already-stale dependencies=%s',async(staleBeforeDelete)=>{
 const fixture=await createAuthFixture();try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',1000,10000,1,1,$3)`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
  const session=await post('/ask/sessions/create',command({scope:{kind:'business'}}));const sessionId=(session.body as {result:{sessionId:string}}).result.sessionId;
  const composition:AskAnswerComposition={agentLimits:{maxSteps:3,maxInputBytes:100000,maxOutputTokens:1000,deadlineMs:60000},allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'})};
  const registry=(agent:AskAgentStepAdapter)=>registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{...composition,agent}});
  const base={endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask.answer'};let firstSteps=0;
  const first=await post('/ask/sessions/turn',command({sessionId,version:1,question:'Private global task count inquiry'}));const firstId=(first.body as {result:{requestId:string}}).result.requestId;
  await runOnce(fixture.db,{registry:registry({...base,async runStep(){firstSteps++;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:firstSteps===1?null:{claims:[],abstained:true},toolCalls:firstSteps===1?[{id:'source-free-global-exact',name:'read_exact',input:{operation:'tasks'}}]:[]};}}),owner:'source-free-history-first',limit:20});
  expect((await post('/ask/answers/read',{requestId:firstId})).body).toMatchObject({state:'complete',answer:{exactResults:[{operation:'tasks'}]}});
  const second=await post('/ask/sessions/turn',command({sessionId,version:2,question:'Private dependent interpretation'}));const secondId=(second.body as {result:{requestId:string}}).result.requestId;
  await runOnce(fixture.db,{registry:registry({...base,async runStep(input){expect(JSON.stringify(input.transcript)).toContain('Private global task count inquiry');return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:{claims:[],abstained:true},toolCalls:[]};}}),owner:'source-free-history-second',limit:20});
  expect((await post('/ask/answers/read',{requestId:secondId})).body).toMatchObject({state:'complete'});
  const third=await post('/ask/sessions/turn',command({sessionId,version:3,question:'Private transitive interpretation'}));const thirdId=(third.body as {result:{requestId:string}}).result.requestId;
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});let transcript='';
  const worker=await fixture.database.appRuntimeSession();const running=runOnce(worker,{registry:registry({...base,async runStep(input){transcript=JSON.stringify(input.transcript);entered();await held;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},answer:{claims:[],abstained:true},toolCalls:[]};}}),owner:'source-free-history-held',limit:20});
  try{await ready;expect(transcript).toContain('Private dependent interpretation');if(staleBeforeDelete){await fixture.db.query("UPDATE crm_ask_requests SET state='stale',reason='source_changed',question=NULL,result=NULL,result_at=NULL,version=version+1,epoch=epoch+1 WHERE id=$1",[firstId]);for(const id of [firstId,secondId,thirdId])expect((await post('/ask/answers/read',{requestId:id})).body).toMatchObject({state:'stale',question:null,answer:null});}const history=await post('/ask/history/list',{});const revision=(history.body as {items:{requestId:string;historyRevision:number}[]}).items.find(item=>item.requestId===firstId)!.historyRevision;const erased=await post('/ask/history/change',command({requestId:firstId,expectedRevision:revision,action:{kind:'delete'}}));expect(erased.body).toMatchObject({result:{state:'deleted'}});expect(erased.status).toBe(200);}finally{release();await running;}
  for(const requestId of [firstId,secondId,thirdId]){expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'deleted',question:null,fallback:null,answer:null});const row=(await fixture.db.query<{question:string|null;result:unknown;scope:unknown;initial_contexts:unknown;initial_access_closure:unknown}>('SELECT question,result,scope,initial_contexts,initial_access_closure FROM crm_ask_requests WHERE id=$1',[requestId])).rows[0]!;expect(row).toEqual({question:null,result:null,scope:null,initial_contexts:null,initial_access_closure:null});}
  expect((await fixture.db.query<{dispatch_state:string}>("SELECT dispatch_state FROM crm_ask_financial_receipts WHERE request_id=$1 AND stage='answer'",[thirdId])).rows[0]!.dispatch_state).toBe('settled');
 }finally{await fixture.stop();}
});
