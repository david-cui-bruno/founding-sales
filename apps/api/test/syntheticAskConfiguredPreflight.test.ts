import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {askAnswerReadResultSchema} from '@fss/contracts';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {syntheticPaidBudget} from '../../worker/test/support/syntheticPaidBudget.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import {parseSyntheticAskFixtures,prepareSyntheticAskFixture} from './support/syntheticAskFixtures.ts';

// Structural preflight: scripted SDK outputs establish composition and evidence
// contracts, never model usefulness, semantic truth or native acquisition.
it('runs all eight synthetic scopes through configured SDK workers and erases dependent history through public source deletion',async()=>{
 const fixture=await createAuthFixture();try{
  const cases=parseSyntheticAskFixtures(readFileSync(new URL('../../../tools/ask-evaluation/fixtures/ask-contract-v4.json',import.meta.url))).cases;
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.ask_sdk',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:2,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,route);
  expect((await saveDisabledPurpose('e'.repeat(64))).status).toBe(200);
  const prepared=[];
  for(const item of cases){
   const firmId=await seedFirm(fixture,{name:item.firmName,assignedUserId:fixture.alpha.admin.userId});
   prepared.push({item,firmId,...await prepareSyntheticAskFixture(post,command,{workspaceId:fixture.alpha.workspaceId,firmId},item)});
  }
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-eight-case-preflight-not-provider-quality',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  const retained=[];
  let maxSerializedBytes=0;
  const budget=syntheticPaidBudget({maxSteps:17,maxCents:408,inputTokenPriceMicros:6.6,outputTokenPriceMicros:33,persist:()=>{}});
  for(const setup of prepared){
   const {item,firmId}=setup;
   const useExact=item.initialScope==='firm_no_sources'||item.category==='pilot_ambiguity';
   const prompts:string[]=[];let calls=0;
   const model=new MockLanguageModelV3({doGenerate:async input=>{
    const serializedBytes=Buffer.byteLength(JSON.stringify(input),'utf8')+2048;
    maxSerializedBytes=Math.max(maxSerializedBytes,serializedBytes);
    expect(serializedBytes).toBeLessThanOrEqual(30000);
    expect(input.maxOutputTokens).toBeDefined();
    expect(input.maxOutputTokens).toBeLessThanOrEqual(1000);
    return budget.run(input,input.maxOutputTokens!,async()=>{
    calls++;const prompt=JSON.stringify(input.prompt);prompts.push(prompt);
    const lookup=useExact&&calls===1;
    return {content:[lookup?{type:'tool-call' as const,toolCallId:`observed-${item.id}`,toolName:'read_exact',input:JSON.stringify({operation:item.id==='crm2_02'?'tasks':'opportunities',firmId})}:{type:'tool-call' as const,toolCallId:`finish-${item.id}`,toolName:'emit_answer',input:JSON.stringify({claims:[{text:item.initialScope==='firm_no_sources'?'This answer reports the observed current CRM records.':item.originals[0]!.text,kind:'fact',citationWindowIds:item.initialScope==='selected'?['w1']:[],...(useExact?{exactResultToolCallIds:['e1']}:{})}],abstained:false})}],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
    });
   }});
   const registry=await composeWorker(model);
   const requested=await post('/ask/answers/request',command({question:item.question,execution:'agent_v1',...setup.requestScope}));expect(requested.status).toBe(200);
   const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
   const result=await runOnce(db,{registry,owner:`preflight-${item.id}`,limit:20});expect(result.failed).toBe(0);
   const read=await post('/ask/answers/read',{requestId,includeExactResultCitations:true});expect(read.status).toBe(200);
   const answer=askAnswerReadResultSchema.parse(read.body);
   expect(answer,JSON.stringify({answer,prompts})).toMatchObject({state:'complete',answer:{resultVersion:'agent_v1',coverage:{acquisition:'unverified'}}});
   expect(calls).toBe(useExact?2:1);
   expect((await post('/ask/answers/diagnostics',{requestId})).body).toMatchObject({state:'complete',completedSteps:useExact?2:1,requestedToolNames:useExact?['read_exact']:[],executedToolNames:useExact?['read_exact']:[],usage:{inputTokens:calls*50,outputTokens:calls*10}});
   const claim=answer.answer!.claims[0]!;
   if(useExact)expect(claim.exactResultToolCallIds).toEqual([`observed-${item.id}`]);
   if(item.initialScope==='selected'){
    expect(claim.citationWindowIds[0]).toMatch(/^[a-f0-9-]{36}$/u);
    expect((await post('/ask/answers/source/read',{requestId,expectedVersion:1,windowId:claim.citationWindowIds[0]})).body).toMatchObject({source:{passage:{text:item.originals[0]!.text}}});
    expect(prompts[0]).toContain('selected_unverified_text');
   }else expect(claim.citationWindowIds).toEqual([]);
   for(const prompt of prompts){
    for(const label of [...item.expected,...item.forbidden])expect(prompt).not.toContain(label);
    if(item.id==='crm2_02'){expect(prompt).not.toContain('Birch setup tasks:');expect(prompt).not.toContain(setup.cleanupSources[0]!.sourceId);}
   }
   retained.push({setup,requestId});
  }
  expect(budget.snapshot().startedSteps).toBe(12);
  expect(budget.snapshot().allocatedCents).toBeLessThanOrEqual(408);
  process.stdout.write(`Controlled SDK framing preflight: ${budget.snapshot().startedSteps} fake calls, maximum ${maxSerializedBytes} serialized UTF-8 bytes including 2048 overhead, ${budget.snapshot().allocatedCents} conservative cents allocated (no provider dispatch).\n`);
  const history=await post('/ask/history/list',{});expect(history.status).toBe(200);expect(history.body).toMatchObject({items:expect.arrayContaining(retained.map(({requestId})=>expect.objectContaining({requestId,state:'complete'})))});
  for(const {setup,requestId} of retained){
   for(const source of setup.cleanupSources)expect((await post('/crm/imports/delete',command({sourceId:source.sourceId,expectedSourceRevision:source.revision,expectedMetadataRevision:source.metadataRevision}))).status).toBe(200);
   const read=await post('/ask/answers/read',{requestId,includeExactResultCitations:true});
   if(setup.cleanupSources.length)expect(read.body,setup.item.id).toMatchObject({state:setup.item.id==='crm2_02'?'stale':'deleted',question:null,answer:null,fallback:null});
   else expect(read.body).toMatchObject({state:'complete'});
   if(setup.cleanupSources.length){
    const erasedHistory=await post('/ask/history/list',{});
    if(setup.item.id==='crm2_02')expect(erasedHistory.body).toMatchObject({items:expect.arrayContaining([expect.objectContaining({requestId,question:null,state:'stale'})])});
    else expect((erasedHistory.body as {items:{requestId:string}[]}).items.map(item=>item.requestId)).not.toContain(requestId);
    if(setup.item.id==='crm2_02')expect(JSON.stringify(read.body)).not.toContain('Check dimensions');
   }
  }
 }finally{await fixture.stop();}
},90000);
