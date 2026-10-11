import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {REQUIRED_SCHEMA} from '@fss/domain/db/schemaRange.ts';
import {createCrmCapabilityRuntime} from '@fss/domain/crm/capabilityStartup.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {crmExtractJobHandler,type CrmExtractionAdapter} from '../../worker/src/handlers/crmExtract.ts';
import {createBedrockCrmExtractionAdapter} from '../../worker/src/providers/crmBedrock.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

for(const mode of ['full','invalid','negative','fractional','oversized','overusage','before_mutation','after_mutation','before_run_mutation','after_run_mutation'] as const)it(`preserves extraction reservation and publication guards: ${mode}`,async()=>{
 const f=await createAuthFixture();
 try{
  const db=await f.database.appRuntimeSession();
  const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'controlled.native',accessGrantVersion:'controlled',dataHandlingVersion:'controlled',fundingVerifiedUntil:'2099-01-01T00:00:00Z'};
  const runtime=createCrmCapabilityRuntime({capture:false,extraction:route},{implementationCommit:null,imageDigest:null,side:'api',schemaVersion:REQUIRED_SCHEMA,gmailAvailable:false});
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:runtime});
  const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  const personId=((await post('/crm/people/create',command({fullName:'Bounded synthetic source'}))).body as {result:{personId:string}}).result.personId;
  const text='Original '.repeat(200);
  expect((await post('/crm/people/source/add',command({personId,sourceKey:'controlled-bound',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}))).status).toBe(200);
  const original=((await post('/crm/people/read',{personId})).body as {sources:{workspaceId:string;sourceId:string;revision:number;contentHash:string}[]}).sources[0]!;
  const source={workspaceId:original.workspaceId,sourceId:original.sourceId,revision:original.revision,contentHash:original.contentHash,kind:'selected_note' as const,locator:null};
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:route.endpointId,modelVersion:route.modelVersion,accessGrantVersion:route.accessGrantVersion,dataHandlingVersion:route.dataHandlingVersion,dailyCeilingCents:100,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-only',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let calls=0,checks=0;
  const native=createBedrockCrmExtractionAdapter({...route,surface:{converse:async input=>{calls++;expect(input.toolConfig?.tools).toHaveLength(1);if(mode==='after_mutation')adapter.inputBound=()=>({maxInputTokens:1});if(mode==='after_run_mutation')adapter.run=async()=>({acceptance:'accepted',usage:{inputTokens:0,outputTokens:0},claims:[]});return {stopReason:'tool_use',usage:{inputTokens:mode==='overusage'?100000:4000,outputTokens:5},output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'controlled',name:'emit_crm_extraction',input:{claims:[]}}}]}}};}}});
  const adapter:CrmExtractionAdapter={...native};
  const invalid=['invalid','negative','fractional','oversized'].includes(mode);
  if(invalid)adapter.inputBound=()=>({maxInputTokens:mode==='negative'?-1:mode==='fractional'?1.5:mode==='oversized'?1000001:Number.NaN});
  const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({allowControlledEvaluation:true,verifyPurpose:async()=>{checks++;if(mode==='before_mutation'&&checks===2)adapter.inputBound=()=>({maxInputTokens:1});if(mode==='before_run_mutation'&&checks===2)adapter.run=async()=>({acceptance:'accepted',usage:{inputTokens:0,outputTokens:0},claims:[]});return true;},adapter}));
  expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
  await runOnce(db,{registry,owner:'controlled-bound',limit:20});
  const result=await post('/crm/processing/read',{source});
  if(mode==='full')expect(result.body).toMatchObject({state:'complete',claims:[],financial:{dispatchState:'settled'}});
  if(mode==='overusage')expect(result.body).toMatchObject({state:'failed',reason:'provider_usage_exceeded'});
  if(invalid)expect(result.body).toMatchObject({state:'unavailable',reason:'input_unavailable',financial:null});
  if(mode==='before_mutation'||mode==='before_run_mutation')expect(result.body).toMatchObject({state:'unavailable',reason:'reservation_authority_changed'});
  if(mode==='after_mutation'||mode==='after_run_mutation')expect(result.body).toMatchObject({state:'stale',reason:'source_or_authority_changed'});
  expect(calls).toBe(invalid||mode==='before_mutation'||mode==='before_run_mutation'?0:1);
 }finally{await f.stop();}
});
