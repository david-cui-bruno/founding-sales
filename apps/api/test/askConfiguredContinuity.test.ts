import {randomUUID} from 'node:crypto';
import {selectedImportPageSchema} from '@fss/contracts';
import {expect,it} from 'vitest';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

it.each([false,true])('retains only the authorized question after exact-state changes and removes it after scope change or original deletion (source-backed=%s)',async(sourceBacked)=>{
 const fixture=await createAuthFixture();try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.ask_sdk',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:4,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'Continuity firm',assignedUserId:fixture.alpha.admin.userId});
  const opened=await post('/opportunities/v2/open',command({firmId,name:'Pilot',stageKey:'new'}));expect(opened.status).toBe(200);
  const opportunityId=(opened.body as {result:{opportunityId:string}}).result.opportunityId;
  let original:ReturnType<typeof selectedImportPageSchema.parse>['imports'][number]|undefined;
  if(sourceBacked){
   const selection={text:'Pilot needs faster repairs.',subtype:'pasted_text',label:'Synthetic Pilot note',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
   const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
   expect((await post('/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
   original=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:10})).body).imports[0]!;
  }
  expect((await saveDisabledPurpose('c'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-continuity-contract-only',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  const prompts:string[]=[];let calls=0;
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   prompts.push(JSON.stringify(input.prompt));calls++;
   const read=calls<5&&calls%2===1;
   return {content:[read?{type:'tool-call' as const,toolCallId:`current-state-${calls}`,toolName:'read_exact',input:JSON.stringify({operation:'opportunities',firmId})}:{type:'tool-call' as const,toolCallId:`answer-${calls}`,toolName:'emit_answer',input:JSON.stringify({claims:calls>=5?[]:[{text:calls===2?'Pilot is recorded as new.':'Pilot is now recorded as qualified.',kind:'fact',citationWindowIds:sourceBacked?['w1']:[],exactResultToolCallIds:['e1']}],abstained:calls>=5})}],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
  }});
  const registry=await composeWorker(model);
  const created=await post('/ask/sessions/create',command({scope:sourceBacked?{kind:'selected',sources:[{workspaceId:fixture.alpha.workspaceId,sourceId:original!.source.sourceId,kind:'selected_note',revision:original!.source.revision,contentHash:original!.source.contentHash,locator:null}]}:{kind:'firm',firmId}}));expect(created.status).toBe(200);
  const sessionId=(created.body as {result:{sessionId:string}}).result.sessionId;
  const first=await post('/ask/sessions/turn',command({sessionId,version:1,question:'Which stage is Pilot recorded in?'}));expect(first.status).toBe(200);
  const firstId=(first.body as {result:{requestId:string}}).result.requestId;
  expect((await runOnce(db,{registry,owner:'configured-continuity-first',limit:20})).failed).toBe(0);
  expect((await post('/ask/answers/read',{requestId:firstId,includeExactResultCitations:true})).body).toMatchObject({state:'complete',answer:{claims:[{text:'Pilot is recorded as new.',exactResultToolCallIds:['current-state-1']}]}});
  expect((await post('/opportunities/stage',command({opportunityId,expectedStageKey:'new',toStageKey:'qualified',reason:'Human qualification decision'}))).status).toBe(200);
  const followup=await post('/ask/sessions/turn',command({sessionId,version:2,question:'And what is its stage now?'}));expect(followup.status).toBe(200);
  const followupId=(followup.body as {result:{requestId:string}}).result.requestId;
  expect((await runOnce(db,{registry,owner:'configured-continuity-followup',limit:20})).failed).toBe(0);
  expect((await post('/ask/answers/read',{requestId:followupId,includeExactResultCitations:true})).body).toMatchObject({state:'complete',answer:{claims:[{text:'Pilot is now recorded as qualified.',exactResultToolCallIds:['current-state-3']}]}});
  expect(prompts[2]).toContain('Which stage is Pilot recorded in?');
  expect(prompts[2]).not.toContain('Pilot is recorded as new.');
  expect(prompts[2]).not.toContain('current-state-1');
  expect((await post('/ask/answers/read',{requestId:firstId,includeExactResultCitations:true})).body).toMatchObject({state:'stale',question:null,answer:null,fallback:null});
  expect(prompts[3]).toContain('qualified');
  expect((await post('/ask/answers/diagnostics',{requestId:followupId})).body).toMatchObject({requestedToolNames:['read_exact'],executedToolNames:['read_exact'],completedSteps:2});
  if(sourceBacked){
   expect((await post('/crm/imports/delete',command({sourceId:original!.source.sourceId,expectedSourceRevision:original!.source.revision,expectedMetadataRevision:original!.metadata.revision}))).status).toBe(200);
   for(const requestId of [firstId,followupId])expect((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body).toMatchObject({state:expect.stringMatching(/^(stale|deleted)$/u),question:null,answer:null,fallback:null});
   expect((await post('/ask/sessions/read',{sessionId,includeExactResultCitations:true})).body).toMatchObject({turns:[]});
   expect((await post('/ask/sessions/turn',command({sessionId,version:3,question:'Can I still use that removed note?'}))).status).toBe(409);
   expect(prompts).toHaveLength(4);
   expect((await post('/ask/sessions/change',command({sessionId,version:3,action:{kind:'scope',scope:{kind:'firm',firmId},confirmExpansion:true}}))).status).toBe(200);
  }else{
   const otherFirm=await seedFirm(fixture,{name:'Narrowed continuity firm',assignedUserId:fixture.alpha.admin.userId});
   expect((await post('/ask/sessions/change',command({sessionId,version:3,action:{kind:'scope',scope:{kind:'firm',firmId:otherFirm},confirmExpansion:false}}))).status).toBe(409);
   expect((await post('/ask/sessions/change',command({sessionId,version:3,action:{kind:'scope',scope:{kind:'firm',firmId:otherFirm},confirmExpansion:true}}))).status).toBe(200);
  }
  const last=await post('/ask/sessions/turn',command({sessionId,version:4,question:'What can be established in this scope?'}));expect(last.status).toBe(200);
  expect((await runOnce(db,{registry,owner:'configured-continuity-erased',limit:20})).failed).toBe(0);
  expect(prompts[4]).not.toContain('Which stage is Pilot recorded in?');
  expect(prompts[4]).not.toContain('And what is its stage now?');
  expect(prompts[4]).not.toContain('Pilot needs faster repairs.');
 }finally{await fixture.stop();}
});
