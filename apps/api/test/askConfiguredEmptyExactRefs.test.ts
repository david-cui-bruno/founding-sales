import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {selectedImportPageSchema,askAnswerReadResultSchema} from '@fss/contracts';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

async function citationJourney(exactRefs:'absent'|'empty',originalRefs:boolean){
 const fixture=await createAuthFixture();try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'controlled-completion',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:3,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'Completion source firm',assignedUserId:fixture.alpha.admin.userId});
  const text='We need faster repairs.',selection={text,subtype:'pasted_text',label:'Synthetic completion evidence',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
  const previewHash=z.object({previewHash:z.string()}).parse(preview.body).previewHash;
  expect((await post('/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
  const source=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:10})).body).imports[0]!.source;
  expect((await saveDisabledPurpose('a'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-completion-not-provider-proof',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let calls=0;
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   calls++;const prompt=JSON.stringify(input.prompt),id=/\\"id\\":\\"(w[1-9]\d*)\\"/u.exec(prompt)?.[1];if(!id)throw new Error('controlled_current_window_missing');
   const answer={claims:[{text:'The retained source requests faster repairs.',kind:'fact',citationWindowIds:originalRefs?[id]:[],...(exactRefs==='empty'?{exactResultToolCallIds:[]}: {})}],abstained:false};
   return {content:[{type:'tool-call' as const,toolCallId:'completion-output',toolName:'emit_answer',input:JSON.stringify(answer)}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
  }});
  const registry=await composeWorker(model);
  const requested=await post('/ask/answers/request',command({question:'What repair need is stated?',execution:'agent_v1',scope:{sources:[{workspaceId:source.workspaceId,sourceId:source.sourceId,revision:source.revision,contentHash:source.contentHash,kind:'selected_note',locator:null}]}}));expect(requested.status).toBe(200);
  const requestId=z.object({result:z.object({requestId:z.uuid()})}).parse(requested.body).result.requestId;
  expect((await runOnce(db,{registry,owner:'ordinary-completion',limit:10})).failed).toBe(0);
  const read=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId})).body),diagnostics=(await post('/ask/answers/diagnostics',{requestId})).body;
  let citation:unknown=null;if(read.answer){citation=(await post('/ask/answers/source/read',{requestId,expectedVersion:1,windowId:read.answer.claims[0]!.citationWindowIds[0]})).body;}
  return {calls,read,diagnostics,citation};
 }finally{await fixture.stop();}
}

// Sonnet v4 responses 6–11 included an explicit empty exact-reference array
// alongside valid source handles. Empty and omitted exact refs mean the same thing.
it.each(['absent','empty'] as const)('publishes source-only SDK answers with %s exact references through the registered worker',async refs=>{
 const result=await citationJourney(refs,true);
 expect(result).toMatchObject({calls:1,read:{state:'complete',reason:null,answer:{claims:[{text:'The retained source requests faster repairs.',verification:'cited_unverified'}],abstained:false}},citation:{source:{passage:{text:'We need faster repairs.'}}},diagnostics:{completedSteps:1,usage:{inputTokens:50,outputTokens:10},cost:{unsettledCents:0,estimated:false}}});
 expect(result.read.answer!.claims[0]!.citationWindowIds[0]).toMatch(/^[a-f0-9-]{36}$/u);
});
it.each(['absent','empty'] as const)('refuses unsupported SDK claims with %s exact references and no original authority',async refs=>{
 const result=await citationJourney(refs,false);
 expect(result).toMatchObject({calls:1,read:{state:'unavailable',reason:'unsupported_answer',answer:null},diagnostics:{completedSteps:1,usage:{inputTokens:50,outputTokens:10},cost:{unsettledCents:0,estimated:false}}});
});
