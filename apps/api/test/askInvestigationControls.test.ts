import {seedFirm} from './support/crmSeed.ts';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';

async function setup(){
 const fixture=await createAuthFixture();
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
 const command=(body:Record<string,unknown>)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 const created=await post('/crm/people/create',command({fullName:'Cancellation evidence'}));const personId=(created.body as {result:{personId:string}}).result.personId;
 await post('/crm/people/source/add',command({personId,sourceKey:'cancel-original',excerpt:'Please discuss repair coordination.',occurredAt:'2026-10-01T14:00:00Z'}));
 const page=await post('/crm/people/read',{personId});const original=(page.body as {sources:Record<string,unknown>[]}).sources[0]!;
 await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by,agent_limits) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1,1,$3,'{"maxSteps":3,"maxInputBytes":50000,"maxOutputTokens":1000,"deadlineMs":60000}')`,[fixture.alpha.workspaceId,'a'.repeat(64),fixture.alpha.admin.userId]);
 const request=await post('/ask/answers/request',command({question:'What should we discuss?',execution:'agent_v1',agentScope:{kind:'person',personId},scope:{sources:[{workspaceId:original['workspaceId'],sourceId:original['sourceId'],revision:original['revision'],contentHash:original['contentHash'],kind:'selected_note',locator:null}]}}));
 expect(request.status).toBe(200);const requestId=(request.body as {result:{requestId:string}}).result.requestId;
 return {fixture,post,command,requestId,personId};
}
it('cancels queued Ask work through a private command without dispatching or losing keyword evidence',async()=>{
 const {fixture,post,command,requestId}=await setup();try{
 expect((await post('/ask/answers/cancel',command({requestId,expectedVersion:1}))).status).toBe(200);
 let calls=0;const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{agent:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask',async runStep(){calls++;throw new Error('Cancelled work must not dispatch');}},agentLimits:{maxSteps:3,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000},allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'})}});
 await runOnce(fixture.db,{registry,owner:'cancel-worker',limit:10});expect(calls).toBe(0);
 expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'unavailable',reason:'processing_cancelled',question:'What should we discuss?',progress:{stage:'cancelled'},fallback:expect.any(Object),answer:null});
 }finally{await fixture.stop();}
});

it('requires a fresh explicit further-work preview when the permitted person corpus changes',async()=>{
 const {fixture,post,command,requestId,personId}=await setup();try{
 await post('/ask/answers/cancel',command({requestId,expectedVersion:1}));
 const preview=await post('/ask/answers/investigation/preview',{requestId,expectedVersion:1,mode:'further'});
 expect(preview.body,JSON.stringify(preview.body)).toMatchObject({available:true,scope:{kind:'person',personId},additionalAllowance:{maxSteps:3,ceilingCents:18}});
 const shown=preview.body as {previewHash:string};
 await post('/crm/people/source/add',command({personId,sourceKey:'additional-current-evidence',excerpt:'The scope has changed.',occurredAt:'2026-10-02T14:00:00Z'}));
 const committed=await post('/ask/answers/investigation/commit',command({requestId,expectedVersion:1,mode:'further',previewHash:shown.previewHash}));
 expect(committed.status).toBe(409);
 expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({reason:'processing_cancelled'});
 }finally{await fixture.stop();}
});

it('commits a fresh bounded investigation as a new identity and replays only its command',async()=>{
 const {fixture,post,command,requestId}=await setup();try{
 await post('/ask/answers/cancel',command({requestId,expectedVersion:1}));
 const preview=(await post('/ask/answers/investigation/preview',{requestId,expectedVersion:1,mode:'retry'})).body as {previewHash:string};
 const input=command({requestId,expectedVersion:1,mode:'retry',previewHash:preview.previewHash});
 const committed=await post('/ask/answers/investigation/commit',input);expect(committed.status).toBe(200);
 const newId=(committed.body as {result:{requestId:string}}).result.requestId;expect(newId).not.toBe(requestId);
 expect((await post('/ask/answers/investigation/commit',input)).body).toMatchObject({replayed:true,result:{requestId:newId}});
 expect((await post('/ask/answers/read',{requestId:newId})).body).toMatchObject({state:'pending',question:'What should we discuss?'});
 expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'unavailable',reason:'processing_cancelled'});
 }finally{await fixture.stop();}
});

for(const acceptance of ['accepted','unknown'] as const){
 it(`cancels during an external ${acceptance} call without claiming it was undone or dispatching another step`,async()=>{
 const {fixture,post,command,requestId}=await setup();try{
 let calls=0;const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{agent:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask',async runStep(){
 calls++;
 expect((await post('/ask/answers/cancel',command({requestId,expectedVersion:1}))).status).toBe(200);
 expect((await post('/ask/answers/investigation/preview',{requestId,expectedVersion:1,mode:'retry'})).body).toMatchObject({available:false,reason:'provider_acceptance_unknown'});
 return {acceptance,usage:acceptance==='accepted'?{inputTokens:20,outputTokens:10}:null,answer:null,toolCalls:[]};
 }},agentLimits:{maxSteps:3,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000},allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'})}});
 const workerSession=await fixture.database.appRuntimeSession();
 await runOnce(workerSession,{registry,owner:'cancel-inflight-worker',limit:10});
 await runOnce(workerSession,{registry,owner:'cancel-no-replay-worker',limit:10});expect(calls).toBe(1);
 expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'unavailable',reason:'processing_cancelled',fallback:expect.any(Object),answer:null});
 expect((await post('/ask/answers/investigation/preview',{requestId,expectedVersion:1,mode:'retry'})).body).toMatchObject(acceptance==='accepted'?{available:true}:{available:false,reason:'provider_acceptance_unknown'});
 }finally{await fixture.stop();}
 });
}

it('preserves only current validated exact tool work after cancellation, distinct from generated answers',async()=>{
 const {fixture,post,command,requestId}=await setup();try{
 await post('/ask/answers/cancel',command({requestId,expectedVersion:1}));
 const firmId=await seedFirm(fixture,{name:'Completed exact state',assignedUserId:fixture.alpha.salesperson.userId});
 const requested=await post('/ask/answers/request',command({question:'Open opportunities?',execution:'agent_v1',agentScope:{kind:'firm',firmId},scope:{sources:[]}}));
 const exactId=(requested.body as {result:{requestId:string}}).result.requestId;
 let calls=0;const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmAskAnswers:{agent:{endpointId:'controlled-answer',modelVersion:'literal-v1',providerKey:'fixture.ask',async runStep(){
 calls++;
 if(calls===2){
 expect((await post('/ask/answers/read',{requestId:exactId})).body).toMatchObject({state:'pending',answer:null,supportedWork:{exactResults:[{operation:'opportunities',value:{count:'0'}}]}});
 expect((await post('/ask/answers/cancel',command({requestId:exactId,expectedVersion:1}))).status).toBe(200);
 }
 return {acceptance:'accepted' as const,usage:{inputTokens:20,outputTokens:10},answer:null,toolCalls:calls===1?[{id:'completed-exact',name:'read_exact',input:{operation:'opportunities',firmId}}]:[]};
 }},agentLimits:{maxSteps:3,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000},allowControlledEvaluation:true,verifyPurpose:async proof=>({configFingerprint:proof.configFingerprint,authorizationFingerprint:proof.authorizationFingerprint,validUntil:'2099-01-01T00:00:00Z',evaluationKind:'controlled_fixture'})}});
 const workerSession=await fixture.database.appRuntimeSession();await runOnce(workerSession,{registry,owner:'partial-exact-worker',limit:10});expect(calls).toBe(2);
 expect((await post('/ask/answers/read',{requestId:exactId})).body).toMatchObject({state:'unavailable',reason:'processing_cancelled',answer:null,supportedWork:{exactResults:[{operation:'opportunities',value:{count:'0'}}]}});
 // This controlled external ownership change models permission revocation, not a product command.
 await fixture.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[fixture.alpha.workspaceId,firmId,fixture.alpha.admin.userId]);
 const redacted=(await post('/ask/answers/read',{requestId:exactId})).body;expect(redacted).toMatchObject({question:null,answer:null,fallback:null});expect(redacted).not.toHaveProperty('supportedWork');
 }finally{await fixture.stop();}
});
