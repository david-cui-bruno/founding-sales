import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {dispatch} from '../src/server.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {composeCrmCapabilities} from '../../worker/src/bootstrap/crmCapabilities.ts';
import {REQUIRED_SCHEMA} from '@fss/domain/db/schemaRange.ts';
import {CRM_SUPPORTED_AGENT_ASK_VERSIONS} from '@fss/domain/crm/capabilityAuthority.ts';
import {createCrmCapabilityRuntime} from '@fss/domain/crm/capabilityStartup.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import {syntheticAskStageScope} from './support/syntheticAcceptanceApproval.ts';
it.each(['gold_context','history_investigation'] as const)('keeps the first configured SDK generation faithful to the approved %s stage through public commands',async stage=>{
 const f=await createAuthFixture();try{
 const db=await f.database.appRuntimeSession();
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'controlled',accessGrantVersion:'controlled',dataHandlingVersion:'controlled',fundingVerifiedUntil:'2099-01-01T00:00:00Z'};
 const limits={maxSteps:stage==='gold_context'?2:6,maxInputBytes:30000,maxOutputTokens:1000,deadlineMs:60000};
 const configuration={capture:false,answer:{...route,agentLimits:limits}};
 const runtime=createCrmCapabilityRuntime(configuration,{implementationCommit:null,imageDigest:null,side:'api',schemaVersion:REQUIRED_SCHEMA,gmailAvailable:false});
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:runtime});
 const cmd=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
 const firmId=await seedFirm(f,{name:'Gold context firm',assignedUserId:f.alpha.admin.userId});
 const text='The exact frozen maintenance evidence is already provided.';
 const added=await post('/crm/firm-sources/add',cmd({firmId,sourceKey:'gold-known-source',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}));expect(added.status).toBe(200);
 const sourceId=(added.body as {result:{sourceId:string}}).result.sourceId;
 const source={workspaceId:f.alpha.workspaceId,sourceId,kind:'selected_note' as const,revision:1,contentHash:createHash('sha256').update(text).digest('hex'),locator:null};
 expect((await post('/ask/purpose/save',cmd({purpose:'answer',enabled:false,expectedRevision:0,endpointId:route.endpointId,modelVersion:route.modelVersion,accessGrantVersion:route.accessGrantVersion,dataHandlingVersion:route.dataHandlingVersion,dailyCeilingCents:100,monthlyCeilingCents:100,inputTokenPriceMicros:'1.1',outputTokenPriceMicros:'5.5',evaluationFingerprint:'a'.repeat(64),...CRM_SUPPORTED_AGENT_ASK_VERSIONS,agentLimits:limits}))).status).toBe(200);
 expect((await post('/ask/purpose/activate',cmd({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-gold-context-not-provider-proof',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
 const request=await post('/ask/answers/request',cmd({question:'What maintenance evidence is supported?',execution:'agent_v1',...syntheticAskStageScope(stage,firmId,source)}));expect(request.status).toBe(200);
 let generations=0,firstPrompt='';
 const model=new MockLanguageModelV3({doGenerate:async input=>{generations++;firstPrompt=JSON.stringify(input.prompt);return {content:[{type:'text',text:'{"claims":[],"abstained":true}'}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:20,noCache:20,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};}});
 const composed=await composeCrmCapabilities({configuration,runtime:{...runtime,side:'worker'},openSession:async()=>({session:await f.database.appRuntimeSession(),close:async()=>{}}),answerModel:model,loadSurface:async()=>({endpointId:route.endpointId,converse:async()=>{throw new Error('No extraction/embedding dispatch');}})});
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composed.handlers});
 await runOnce(db,{registry,owner:'gold-context-configured-worker',limit:20});
 expect(generations).toBe(1);if(stage==='gold_context'){expect(firstPrompt).toContain(text);expect(firstPrompt).toContain(sourceId);}else{expect(firstPrompt).not.toContain(text);expect(firstPrompt).not.toContain(sourceId);}
 expect((await post('/ask/answers/read',{requestId:(request.body as {result:{requestId:string}}).result.requestId})).body).toMatchObject({state:'complete'});
 }finally{await f.stop();}
});
