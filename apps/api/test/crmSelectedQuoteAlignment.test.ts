import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {crmProcessingResultSchema,selectedImportPageSchema} from '@fss/contracts';
import {activateForwardFixture} from './support/crmForwardScopeFixture.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {composeCrmCapabilities} from '../../worker/src/bootstrap/crmCapabilities.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
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
  const forward=await activateForwardFixture(fixture),{db,post,command,runtime}=forward;
  const route={...forward.route,region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const};
  const configuration={capture:true,extraction:route};
  const firmId=await seedFirm(fixture,{name:'Synthetic alignment firm',assignedUserId:fixture.alpha.admin.userId});
  await forward.extraction();
  let calls=0;
  for(const item of cases){
   const selection={text:item.text,subtype:item.subtype??'pasted_text',label:item.name,direction:'unknown',participants:[],occurredAt:new Date().toISOString(),attachments:[]};
   const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
   expect((await post('/crm/imports/commit',command({...selection,firmId,personId:null,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
   const imported=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:20})).body).imports.find(entry=>entry.metadata.label===item.name)!;
   const nativeSource={workspaceId:imported.source.workspaceId,sourceId:imported.source.sourceId,revision:imported.source.revision,contentHash:imported.source.contentHash,kind:'selected_note' as const,locator:null};
   expect((await post('/crm/processing/request',command({source:nativeSource}))).status).toBe(409);
   const source=await forward.original(item.text);
   const composed=await composeCrmCapabilities({configuration,runtime:{...runtime,side:'worker'},openSession:async()=>({session:db,close:async()=>{}}),loadSurface:async()=>({endpointId:route.endpointId,converse:async input=>{calls++;expect(JSON.parse(input.messages[0]!.content[0]!.text)).toMatchObject({text:item.text});return {stopReason:'tool_use',usage:{inputTokens:127,outputTokens:84},output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'controlled-alignment',name:'emit_crm_extraction',input:{claims:[item.claim]}}}]}}};}})});
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
