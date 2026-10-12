import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {askAnswerReadResultSchema} from '@fss/contracts';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

const windowsSchema=z.object({windows:z.array(z.object({id:z.string(),text:z.string(),source:z.object({sourceId:z.uuid()})}))});
const receiptSchema=z.object({result:z.object({sourceId:z.uuid()})});
const requestSchema=z.object({result:z.object({requestId:z.uuid()})});
const sessionSchema=z.object({result:z.object({sessionId:z.uuid()})});

// Controlled model outputs prove host discovery, citation navigation and erasure,
// not that a hosted model reliably notices or interprets a later correction.
it('finds a separately retained cancellation beyond an initial lexical match and erases cited session answers after deletion',async()=>{
 const fixture=await createAuthFixture();
 try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.ask_sdk',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:4,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  const firmId=await seedFirm(fixture,{name:'Juniper history correction',assignedUserId:fixture.alpha.admin.userId});
  const promised='October 1: I will send the sample on Thursday.';
  const cancelled='October 2: Cancel that Thursday plan. Stock is unavailable; there is no replacement date.';
  async function add(text:string){
   const selection={text,subtype:'pasted_text',label:'Synthetic separately retained note',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
   const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
   const result=await post('/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:z.object({previewHash:z.string()}).parse(preview.body).previewHash,parserVersion:'selected-v1'}));expect(result.status).toBe(200);
   return receiptSchema.parse(result.body).result.sourceId;
  }
  await add(promised);const correctionId=await add(cancelled);
  expect((await saveDisabledPurpose('c'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-history-lifecycle-not-provider-quality',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let generation=0;let modelFailure:unknown;
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   try{
    generation++;
    const results=input.prompt.flatMap(message=>message.role==='tool'?message.content.flatMap(part=>part.type==='tool-result'&&part.output.type==='json'?[{name:part.toolName,value:part.output.value}]:[]):[]);
    const tool=(toolName:string,input:object)=>({type:'tool-call' as const,toolCallId:`history-${generation}`,toolName,input:JSON.stringify(input)});
    let response;
    if(generation===1){expect(JSON.stringify(input.prompt)).not.toContain(promised);expect(JSON.stringify(input.prompt)).not.toContain(cancelled);response=tool('search_history',{query:'sample',limit:5});}
    else if(generation===2){
     const search=windowsSchema.parse(results.find(result=>result.name==='search_history')?.value);
     expect(search.windows.map(window=>window.text)).toEqual([promised]);
     response=tool('browse_history',{limit:5});
    }else if(generation===3){
     const browse=windowsSchema.parse(results.find(result=>result.name==='browse_history')?.value);
     expect(browse.windows.map(window=>window.text)).toEqual(expect.arrayContaining([promised,cancelled]));
     response=tool('read_conversation',{sourceId:correctionId,kind:'selected_note',limit:3});
    }else if(generation===5){response=tool('browse_history',{limit:5});}
    else{
     const latest=windowsSchema.parse(results.at(-1)?.value);
     const correction=latest.windows.find(window=>window.text===cancelled);
     expect(correction).toBeDefined();
     response=tool('emit_answer',{claims:[{text:'The later note cancels the Thursday plan because stock is unavailable; it gives no replacement date.',kind:'fact',citationWindowIds:[correction!.id],exactResultToolCallIds:[]}],abstained:false});
    }
    return {content:[response],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
   }catch(error){modelFailure=error;throw error;}
  }});
  const registry=await composeWorker(model);
  const sessionId=sessionSchema.parse((await post('/ask/sessions/create',command({scope:{kind:'firm',firmId}}))).body).result.sessionId;
  const first=await post('/ask/sessions/turn',command({sessionId,version:1,question:'What is the latest plan for sending the sample?'}));expect(first.status).toBe(200);
  const firstId=requestSchema.parse(first.body).result.requestId;
  expect((await runOnce(db,{registry,owner:'configured-history-correction',limit:20})).failed).toBe(0);expect(modelFailure).toBeUndefined();
  const firstAnswer=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId:firstId})).body);
  expect(firstAnswer).toMatchObject({state:'complete',answer:{claims:[{text:'The later note cancels the Thursday plan because stock is unavailable; it gives no replacement date.'}]}});
  const citation=firstAnswer.answer!.claims[0]!.citationWindowIds[0]!;
  expect((await post('/ask/answers/source/read',{requestId:firstId,expectedVersion:1,windowId:citation})).body).toMatchObject({source:{passage:{text:cancelled}}});
  const follow=await post('/ask/sessions/turn',command({sessionId,version:2,question:'Was a replacement date given?'}));expect(follow.status).toBe(200);
  const followId=requestSchema.parse(follow.body).result.requestId;
  expect((await runOnce(db,{registry,owner:'configured-history-correction-followup',limit:20})).failed).toBe(0);expect(modelFailure).toBeUndefined();
  expect((await post('/ask/answers/read',{requestId:followId})).body).toMatchObject({state:'complete'});
  expect((await post('/crm/imports/delete',command({sourceId:correctionId,expectedSourceRevision:1,expectedMetadataRevision:1}))).status).toBe(200);
  for(const requestId of [firstId,followId])expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'stale',question:null,answer:null,fallback:null});
  expect((await post('/ask/sessions/read',{sessionId})).body).toMatchObject({turns:[]});
  expect((await post('/ask/answers/source/read',{requestId:firstId,expectedVersion:1,windowId:citation})).status).toBe(404);
 }finally{await fixture.stop();}
});
