import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {composeCrmCapabilities} from '../../worker/src/bootstrap/crmCapabilities.ts';
import {REQUIRED_SCHEMA} from '@fss/domain/db/schemaRange.ts';
import {CRM_SUPPORTED_AGENT_ASK_VERSIONS} from '@fss/domain/crm/capabilityAuthority.ts';
import {createCrmCapabilityRuntime} from '@fss/domain/crm/capabilityStartup.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import type {AskAgentStepAdapter} from '@fss/domain/crm/askAnswerPorts.ts';

// Recorded actual synthetic step3: legal tools and2359 input tokens. Legacy host
// reserved2344 and stopped before executing tools. No live model is called here.
const captured=[{type:'text' as const,text:'I need to search for commitments and deadlines in the retained business conversations for this firm. Let me start by looking for relevant evidence.'},{type:'tool-call' as const,toolCallId:'tooluse_mFc1VT0AUq2j9R0qQNUDAc',toolName:'search_history',input:'{"query":"commitment deadline","limit":20}'},{type:'tool-call' as const,toolCallId:'tooluse_lfnQt6SIE5TuCViR6cBryN',toolName:'search_history',input:'{"query":"promise deliver by when","limit":20}'}];
async function journey(options:{maxInputBytes?:number;maxSteps?:number;usage?:number;mutate?:(agent:AskAgentStepAdapter)=>AskAgentStepAdapter}={}){
 const fixture=await createAuthFixture();
 try{
  const db=await fixture.database.appRuntimeSession();const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'controlled',accessGrantVersion:'controlled',dataHandlingVersion:'controlled',fundingVerifiedUntil:'2099-01-01T00:00:00Z'};
  const limits={maxSteps:options.maxSteps??3,maxInputBytes:options.maxInputBytes??50000,maxOutputTokens:1000,deadlineMs:60000};
  const runtime=createCrmCapabilityRuntime({capture:false,answer:{...route,agentLimits:limits}},{implementationCommit:null,imageDigest:null,side:'api',schemaVersion:REQUIRED_SCHEMA,gmailAvailable:false});
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...fixture.deps,db},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:runtime});
  const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  expect((await post('/ask/purpose/save',command({purpose:'answer',enabled:false,expectedRevision:0,endpointId:route.endpointId,modelVersion:route.modelVersion,accessGrantVersion:route.accessGrantVersion,dataHandlingVersion:route.dataHandlingVersion,dailyCeilingCents:100,monthlyCeilingCents:100,inputTokenPriceMicros:'1.1',outputTokenPriceMicros:'5.5',evaluationFingerprint:'a'.repeat(64),...CRM_SUPPORTED_AGENT_ASK_VERSIONS,agentLimits:limits}))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-captured-output-not-live-provider-proof',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  const firmId=await seedFirm(fixture,{name:'Example Sales',assignedUserId:fixture.alpha.admin.userId});
  let calls=0;
  const model=new MockLanguageModelV3({doGenerate:async()=>{calls++;const usage=options.usage??(calls===1?2359:20);return {content:calls===1?captured:[{type:'text',text:'{"claims":[],"abstained":true}'}],finishReason:{unified:calls===1?'tool-calls':'stop',raw:calls===1?'tool_use':'end_turn'},usage:{inputTokens:{total:usage,noCache:usage,cacheRead:0,cacheWrite:0},outputTokens:{total:156,text:156,reasoning:0}},warnings:[]};}});
  const composed=await composeCrmCapabilities({configuration:{capture:false,answer:{...route,agentLimits:limits}},runtime:{...runtime,side:'worker'},openSession:async()=>({session:await fixture.database.appRuntimeSession(),close:async()=>{}}),answerModel:model,loadSurface:async()=>({endpointId:route.endpointId,converse:async()=>{throw new Error('No extraction/embedding dispatch');}})});const ordinary=composed.handlers.crmAskAnswers!.agent!;const agent=options.mutate?.(ordinary)??ordinary;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composed.handlers,crmAskAnswers:{...composed.handlers.crmAskAnswers!,agent}});
  const requested=await post('/ask/answers/request',command({question:'What commitments and deadlines are supported for this firm?',execution:'agent_v1',agentScope:{kind:'firm',firmId},scope:{sources:[]}}));expect(requested.status).toBe(200);
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  await runOnce(db,{registry,owner:'controlled-sdk-input-accounting',limit:10});
  return {calls,read:(await post('/ask/answers/read',{requestId})).body,diagnostics:(await post('/ask/answers/diagnostics',{requestId})).body,reservations:(await db.query<{max_input_tokens:number;state:string}>('SELECT max_input_tokens,state FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2',[fixture.alpha.workspaceId,requestId])).rows};
 }finally{await fixture.stop();}
}
it('reserves complete ordinary SDK input before dispatch so captured legal tools execute',async()=>{
 const result=await journey();expect(result).toMatchObject({calls:2,read:{state:'complete'},diagnostics:{executedToolNames:['search_history']}});expect(Number(result.reservations[0]!.max_input_tokens)).toBeGreaterThanOrEqual(2359);
});
it('refuses full composed input over the explicit byte ceiling before any call or reservation',async()=>{
 const result=await journey({maxInputBytes:3000});expect(result).toMatchObject({calls:0,read:{state:'unavailable',reason:'input_bound_reached'},reservations:[]});
});
it('retains refusal when measured usage exceeds its complete reserved allowance',async()=>{
 const result=await journey({usage:1000000});expect(result).toMatchObject({calls:1,read:{state:'unavailable',reason:'processing_failed'},diagnostics:{executedToolNames:[]}});
});
it('reports actual model step exhaustion separately from input byte exhaustion',async()=>{
 const result=await journey({maxSteps:1});expect(result).toMatchObject({calls:1,read:{state:'unavailable',reason:'step_bound_reached'},diagnostics:{executedToolNames:['search_history']}});
});
it.each([null,{inputBytes:NaN,maxInputTokens:1},{inputBytes:1,maxInputTokens:-1},{inputBytes:1,maxInputTokens:Number.MAX_SAFE_INTEGER+1}])('refuses invalid adapter input bounds before reservation or external call (%j)',async bound=>{
 const result=await journey({mutate:agent=>({...agent,inputBound:()=>bound})});expect(result).toMatchObject({calls:0,read:{state:'unavailable',reason:'processing_failed'},reservations:[]});
});
it('invalidates the request if the input-bound implementation changes during external wait',async()=>{
 const result=await journey({mutate:ordinary=>{const agent={...ordinary};const run=ordinary.runStep;agent.runStep=async request=>{const output=await run(request);agent.inputBound=()=>({inputBytes:1,maxInputTokens:1});return output;};return agent;}});expect(result).toMatchObject({calls:1,read:{state:'stale'},diagnostics:{executedToolNames:[]}});
});
it('refuses an input-bound implementation changed while preparing the call',async()=>{
 const result=await journey({mutate:ordinary=>{const agent={...ordinary};agent.inputBound=request=>{const bound=ordinary.inputBound!(request);agent.inputBound=()=>bound;return bound;};return agent;}});expect(result).toMatchObject({calls:0,read:{state:'stale'},reservations:[]});
});
