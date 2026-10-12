import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {askAnswerReadResultSchema,selectedImportPageSchema} from '@fss/contracts';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

// Scripted output proves delivery of contextual guidance, canonical citations and
// lifecycle. It does not prove that a hosted model follows the guidance.
it('preserves anonymous first-person note content without promoting firm context into speaker identity',async()=>{
 const fixture=await createAuthFixture();
 try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.precision',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:3,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'Harbor precision',assignedUserId:fixture.alpha.admin.userId});
  const text='Harbor precision: If you send a scrubbed sample, I could show how the fields map next week.';
  const selection={text,subtype:'pasted_text',label:'Anonymous conditional offer',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
  expect((await post('/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:z.object({previewHash:z.string()}).parse(preview.body).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
  const imported=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:10})).body).imports[0]!;
  const source={workspaceId:imported.source.workspaceId,sourceId:imported.source.sourceId,revision:imported.source.revision,contentHash:imported.source.contentHash,kind:'selected_note',locator:null};
  expect((await saveDisabledPurpose('d'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-precision-not-actual-quality',limitations:['representative_quality_unverified']}}))).status).toBe(200);
  let modelFailure:unknown;
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   try{
    const user=input.prompt.find(message=>message.role==='user');
    const context=z.object({context:z.array(z.object({windows:z.array(z.object({id:z.string(),text:z.string(),source:z.object({speaker:z.null()}),interpretationLimits:z.object({speakerIdentity:z.string()})}))}).passthrough())}).parse(user?.role==='user'?JSON.parse(user.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('')):null);
    const window=context.context[0]!.windows[0]!;
    expect(window.text).toBe(text);
    expect(window.interpretationLimits.speakerIdentity).toContain('A firm association does not identify the speaker');
    expect(window.interpretationLimits.speakerIdentity).toContain('the note says');
    return {content:[{type:'tool-call' as const,toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'The note offers a field-mapping demonstration next week if a scrubbed sample is sent; its author is unidentified.',kind:'fact',citationWindowIds:[window.id],exactResultToolCallIds:[]}],abstained:false})}],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:20,text:20,reasoning:0}},warnings:[]};
   }catch(error){modelFailure=error;throw error;}
  }});
  const registry=await composeWorker(model);
  const requested=await post('/ask/answers/request',command({question:'What help was offered?',execution:'agent_v1',agentScope:{kind:'selected',sources:[source]},scope:{sources:[source]}}));expect(requested.status).toBe(200);
  const requestId=z.object({result:z.object({requestId:z.uuid()})}).parse(requested.body).result.requestId;
  await runOnce(db,{registry,owner:'controlled-anonymous-precision',limit:20});
  expect(modelFailure).toBeUndefined();
  const answer=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body);
  expect(answer).toMatchObject({state:'complete',answer:{claims:[{verification:'cited_unverified'}]}});
  const citation=answer.answer!.claims[0]!.citationWindowIds[0]!;
  expect((await post('/ask/answers/source/read',{requestId,expectedVersion:1,windowId:citation})).body).toMatchObject({source:{passage:{text,speaker:null}}});
  expect((await post('/crm/imports/delete',command({sourceId:source.sourceId,expectedSourceRevision:1,expectedMetadataRevision:1}))).status).toBe(200);
  expect((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body).toMatchObject({state:'deleted',question:null,answer:null,fallback:null});
 }finally{await fixture.stop();}
});

it('keeps opportunity opening time distinct from current stage in the configured model observation',async()=>{
 const fixture=await createAuthFixture();
 try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.precision',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:3,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'North time precision',assignedUserId:fixture.alpha.admin.userId});
  const opened=await post('/opportunities/v2/open',command({firmId,name:'North pilot',stageKey:'new'}));expect(opened.status).toBe(200);
  const opportunityId=z.object({result:z.object({opportunityId:z.uuid()})}).parse(opened.body).result.opportunityId;
  expect((await post('/opportunities/stage',command({opportunityId,expectedStageKey:'new',toStageKey:'qualified'}))).status).toBe(200);
  const before=await post('/ask/read',{operation:'opportunities',scope:{firmId},status:'all',limit:20});expect(before.status).toBe(200);
  const canonical=z.object({records:z.array(z.object({name:z.string(),openedAt:z.string(),stageKey:z.string(),status:z.string()}).passthrough())}).parse(before.body);
  expect((await saveDisabledPurpose('e'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-current-state-not-actual-quality',limitations:['representative_quality_unverified']}}))).status).toBe(200);
  let generation=0;let modelFailure:unknown;
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   try{
    generation++;
    if(generation===2){
     const message=input.prompt.find(item=>item.role==='tool');
     const observed=z.object({type:z.literal('json'),value:z.object({records:z.array(z.record(z.string(),z.unknown())),answerGuidance:z.object({limits:z.array(z.string())}),evidenceAuthority:z.object({toolCallId:z.literal('e1')})})}).parse(message?.role==='tool'?message.content.find(part=>part.type==='tool-result')?.output:null).value;
     expect(observed.records).toEqual(canonical.records);
     expect(observed.answerGuidance.limits).toContain('stageKey and status describe current observed CRM state. openedAt records when the opportunity opened; it does not establish its stage or status at that past time.');
    }
    const call=generation===1?{toolCallId:'current-stage',toolName:'read_exact',input:JSON.stringify({operation:'opportunities',firmId})}:{toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'North pilot is currently recorded at the qualified stage.',kind:'fact',citationWindowIds:[],exactResultToolCallIds:['e1']}],abstained:false})};
    return {content:[{type:'tool-call' as const,...call}],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:20,text:20,reasoning:0}},warnings:[]};
   }catch(error){modelFailure=error;throw error;}
  }});
  const registry=await composeWorker(model);
  const requested=await post('/ask/answers/request',command({question:'What stage is North pilot at now?',execution:'agent_v1',agentScope:{kind:'firm',firmId},scope:{sources:[]}}));expect(requested.status).toBe(200);
  const requestId=z.object({result:z.object({requestId:z.uuid()})}).parse(requested.body).result.requestId;
  await runOnce(db,{registry,owner:'controlled-current-time-precision',limit:20});expect(modelFailure).toBeUndefined();
  const answer=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body);
  expect(answer).toMatchObject({state:'complete',answer:{claims:[{citationWindowIds:[],exactResultToolCallIds:['current-stage']}],exactResults:[{value:{records:canonical.records}}]}});
  const after=await post('/ask/read',{operation:'opportunities',scope:{firmId},status:'all',limit:20});expect(after.body).toEqual(before.body);
  expect((await post('/ask/answers/diagnostics',{requestId})).body).toMatchObject({state:'complete',executedToolNames:['read_exact'],usage:{inputTokens:100,outputTokens:40},cost:{unsettledCents:0}});
 }finally{await fixture.stop();}
});
