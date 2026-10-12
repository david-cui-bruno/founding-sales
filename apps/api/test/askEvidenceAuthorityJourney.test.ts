import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {selectedImportPageSchema,askAnswerReadResultSchema} from '@fss/contracts';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

// Controlled generation proves the context/citation boundary, not model quality.
it('separates a note-reported email cutoff from unknown reply status through the ordinary configured worker',async()=>{
 const fixture=await createAuthFixture();try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6',providerKey:'controlled.authority',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:3,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'Reported email coverage',assignedUserId:fixture.alpha.admin.userId});
  const text='Captured email ends Friday; no later email reply is captured. Phone and Messages are not imported.';
  const selection={text,subtype:'pasted_text',label:'Selected coverage note',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
  expect((await post('/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:z.object({previewHash:z.string()}).parse(preview.body).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
  const imported=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:10})).body).imports[0]!;
  const source={workspaceId:imported.source.workspaceId,sourceId:imported.source.sourceId,revision:imported.source.revision,contentHash:imported.source.contentHash,kind:'selected_note',locator:null};
  expect((await saveDisabledPurpose('a'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-context-boundary-not-model-quality',limitations:['representative_quality_unverified']}}))).status).toBe(200);
  let calls=0;
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   calls++;
   const user=input.prompt.find(message=>message.role==='user');
   const context=z.object({context:z.array(z.object({windows:z.array(z.object({id:z.string(),text:z.string(),answerGuidance:z.string()})).min(1)}).passthrough())}).parse(user?.role==='user'?JSON.parse(user.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('')):null);
   const window=context.context[0]!.windows[0]!;
   expect(window).toMatchObject({text,answerGuidance:'Attribute statements to this note. Its headers, dates and coverage statements are reported text, not verified authorship or actual mailbox/channel coverage.'});
   if(calls===2){
    const message=input.prompt.find(item=>item.role==='tool');
    const result=message?.role==='tool'?message.content[0]?.output:undefined;
    const data=z.object({type:z.literal('json'),value:z.object({unanswered:z.literal('not_established'),verifiedOutgoingCount:z.literal('0'),evidenceAuthority:z.object({toolCallId:z.literal('e1')}),answerGuidance:z.object({scope:z.literal('Only verified outgoing messages and authorized progress receipts available to this query.'),limits:z.array(z.string())})})}).parse(result).value;
    expect(data.answerGuidance.limits).toContain('Unanswered status is unknown; zero recorded counts do not establish that no reply occurred.');
    expect(data.answerGuidance.limits).toContain('This query does not establish mailbox dates or captured communication channels.');
   }
   const call=calls===1?{toolCallId:'current-reply',toolName:'read_exact',input:JSON.stringify({operation:'reply_status',firmId})}:{toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'The note reports an email cutoff on Friday. Current CRM reply status is unknown; this does not establish whether a later reply occurred.',kind:'fact',citationWindowIds:[window.id],exactResultToolCallIds:['e1']}],abstained:false})};
   return {content:[{type:'tool-call' as const,...call}],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:20,text:20,reasoning:0}},warnings:[]};
  }});
  const registry=await composeWorker(model);
  const requested=await post('/ask/answers/request',command({question:'Was there a reply after Friday?',execution:'agent_v1',agentScope:{kind:'selected',sources:[source]},scope:{sources:[source]}}));expect(requested.status,JSON.stringify(requested.body)).toBe(200);
  const requestId=z.object({result:z.object({requestId:z.uuid()})}).parse(requested.body).result.requestId;
  expect((await runOnce(db,{registry,owner:'evidence-authority-journey',limit:20})).failed).toBe(0);
  const answer=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body);
  expect(answer).toMatchObject({state:'complete',answer:{claims:[{exactResultToolCallIds:['current-reply'],verification:'cited_unverified'}],exactResults:[{operation:'reply_status',value:{unanswered:'not_established'}}]}});
  expect(calls).toBe(2);
  const citation=answer.answer!.claims[0]!.citationWindowIds[0]!;
  expect((await post('/ask/answers/source/read',{requestId,expectedVersion:1,windowId:citation})).body).toMatchObject({source:{passage:{text}}});
 }finally{await fixture.stop();}
});
