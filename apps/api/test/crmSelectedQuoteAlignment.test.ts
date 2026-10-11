import {REQUIRED_SCHEMA} from '@fss/domain/db/schemaRange.ts';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {crmProcessingResultSchema,selectedImportPageSchema} from '@fss/contracts';
import {createCrmCapabilityRuntime,type CrmCapabilityStartupConfiguration} from '@fss/domain/crm/capabilityStartup.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {composeCrmCapabilities} from '../../worker/src/bootstrap/crmCapabilities.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

// Captured diagnostic output is synthetic; it does not explain the original cohort failures.
const captured={kind:'commitment',interpretation:'Mira commits to sending a proposal by Friday, October 16',status:'stated',locator:'text:0:57',quote:'I will send the proposal Friday, October 16.'};
const cases=[
 {name:'captured',text:'Mira at Example Sales says: "I will send the proposal Friday, October 16."',claim:captured,locator:'text:29:73'},
 {name:'unicode',text:'😀 Mira says: promise.',claim:{...captured,quote:'promise.',locator:'text:0:8'},locator:'text:14:22'},
 {name:'selected-file',subtype:'selected_file',text:'Prefix: promise.',claim:{...captured,quote:'promise.',locator:'text:0:8'},locator:'text:8:16'},
 {name:'valid-repeated',text:'promise. promise.',claim:{...captured,quote:'promise.',locator:'text:9:17'},locator:'text:9:17'},
 {name:'ambiguous',text:'promise. promise.',claim:{...captured,quote:'promise.',locator:'text:1:9'},locator:null},
 {name:'overlapping',text:'aaa',claim:{...captured,quote:'aa',locator:'text:2:4'},locator:null},
 {name:'missing',text:'promise.',claim:{...captured,quote:'invented',locator:'text:0:8'},locator:null},
 {name:'malformed-schema',text:'promise.',claim:{...captured,kind:'invented',quote:'promise.',locator:'text:1:2'},locator:null},
];
it('aligns only unique exact selected-original quotes with UTF16 offsets and retains strict schema and quote refusal',async()=>{
 const fixture=await createAuthFixture();
 try{
  const db=await fixture.database.appRuntimeSession();
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'controlled.alignment',accessGrantVersion:'controlled',dataHandlingVersion:'controlled',fundingVerifiedUntil:'2099-01-01T00:00:00Z'};
  const configuration:CrmCapabilityStartupConfiguration={capture:false,extraction:route};
  const runtime=createCrmCapabilityRuntime(configuration,{implementationCommit:null,imageDigest:null,side:'api',schemaVersion:REQUIRED_SCHEMA,gmailAvailable:false});
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...fixture.deps,db},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:runtime});
  const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  const firmId=await seedFirm(fixture,{name:'Synthetic alignment firm',assignedUserId:fixture.alpha.admin.userId});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:route.endpointId,modelVersion:route.modelVersion,accessGrantVersion:route.accessGrantVersion,dataHandlingVersion:route.dataHandlingVersion,dailyCeilingCents:100,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-external-fake-only',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let calls=0;
  for(const item of cases){
   const selection={text:item.text,subtype:item.subtype??'pasted_text',label:item.name,direction:'unknown',participants:[],occurredAt:new Date().toISOString(),attachments:[]};
   const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
   expect((await post('/crm/imports/commit',command({...selection,firmId,personId:null,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
   const imported=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:20})).body).imports.find(entry=>entry.metadata.label===item.name)!;
   const source={workspaceId:imported.source.workspaceId,sourceId:imported.source.sourceId,revision:imported.source.revision,contentHash:imported.source.contentHash,kind:'selected_note' as const,locator:null};
   const composed=await composeCrmCapabilities({configuration,runtime:{...runtime,side:'worker'},openSession:async()=>({session:await fixture.database.appRuntimeSession(),close:async()=>{}}),loadSurface:async()=>({endpointId:route.endpointId,converse:async input=>{calls++;expect(input.messages[0]!.content[0]!.text).toBe(item.text);return {stopReason:'tool_use',usage:{inputTokens:127,outputTokens:84},output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'controlled-alignment',name:'emit_crm_extraction',input:{claims:[item.claim]}}}]}}};}})});
   const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composed.handlers});
   expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
   expect((await runOnce(db,{registry,owner:'controlled-alignment',limit:20})).failed).toBe(0);
   const result=crmProcessingResultSchema.parse((await post('/crm/processing/read',{source})).body);
   if(item.locator!==null)expect(result,item.name).toMatchObject({state:'complete',claims:[{quote:item.claim.quote,source:{locator:item.locator}}]});
   else expect(result,item.name).toMatchObject({state:'failed',reason:item.name==='malformed-schema'?'invalid_extraction':'invalid_quote',claims:[]});
  }
  expect(calls).toBe(cases.length);
 }finally{await fixture.stop();}
});
