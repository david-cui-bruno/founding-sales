import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {MockLanguageModelV3} from '../../worker/test/support/controlledAskSdkModel.ts';
import {selectedImportPageSchema,askAnswerReadResultSchema} from '@fss/contracts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {configuredAskFixture} from './support/configuredAskFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

// Frozen before scripted outputs: source-supported repairs fact; business history
// requires bounded host search/read, session continuity never broadens scope,
// original citation navigation works, erased sources erase conversation history.
it.each(['bedrock','vertex'] as const)('uses ordinary %s SDK composition, host history tools and current owner approval for cited session answers and deletion',async provider=>{
 const fixture=await createAuthFixture();try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'controlled.ask_sdk',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:4,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,provider==='bedrock'?route:{...route,provider:'google_vertex',region:'us',projectId:'synthetic-ask-project',endpointId:'vertex.us/synthetic-ask-project',modelVersion:'gemini-3.8-flash'});
  const firmId=await seedFirm(fixture,{name:'Configured Ask source firm',assignedUserId:fixture.alpha.admin.userId});
  const text='We need faster repairs.';
  const selection={text,subtype:'pasted_text',label:'Synthetic repairs evidence',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
  expect((await post('/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
  const imported=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:10})).body).imports[0]!;
  expect((await saveDisabledPurpose('a'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'synthetic-fixture-not-actual-provider-proof',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let calls=0;const observedPrompts:string[]=[];
  const model=new MockLanguageModelV3({doGenerate:async input=>{
   calls++;const prompt=JSON.stringify(input.prompt);observedPrompts.push(prompt);
   if(provider==='vertex'&&calls===2){expect(input.prompt).toEqual(expect.arrayContaining([expect.objectContaining({role:'assistant',content:expect.arrayContaining([expect.objectContaining({type:'tool-call',providerOptions:{vertex:{thoughtSignature:'opaque-history-step'}}})])})]));}
   const ids=[...prompt.matchAll(/"id":"(w[1-9]\d*|[a-f0-9-]{36})"/gu),...prompt.matchAll(/\\"id\\":\\"(w[1-9]\d*|[a-f0-9-]{36})\\"/gu)].map(match=>match[1]!);
   const tool=prompt.includes('Resolve repeated name')?{type:'tool-call' as const,toolCallId:'resolve-ambiguous-firm',toolName:'resolve_records',input:JSON.stringify({query:'Repeated Example',kind:'firm',limit:10})}:calls===1?{type:'tool-call' as const,toolCallId:'find-retained-repairs',toolName:'search_history',input:JSON.stringify({query:'repairs',limit:5})}:calls===2?{type:'tool-call' as const,toolCallId:'read-retained-context',toolName:'read_conversation',input:JSON.stringify({sourceId:imported.source.sourceId,kind:'selected_note',limit:3})}:null;
   return {content:tool?[{...tool,...provider==='vertex'?{providerMetadata:{vertex:{thoughtSignature:'opaque-history-step'}}}:{}}]:[{type:'text' as const,text:JSON.stringify({claims:[{text:'The retained source requests faster repairs.',kind:'fact',citationWindowIds:[ids.at(-1)!]}],abstained:false})}],finishReason:{unified:tool?'tool-calls' as const:'stop' as const,raw:tool?'tool_use':'end_turn'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
  }});
  const registry=await composeWorker(model);
  const unstarted=await post('/ask/answers/request',command({question:'Cancelled before processing',execution:'agent_v1',agentScope:{kind:'firm',firmId},scope:{sources:[]}}));expect(unstarted.status).toBe(200);
  const cancelledId=(unstarted.body as {result:{requestId:string}}).result.requestId;
  expect((await post('/ask/answers/diagnostics',{requestId:cancelledId})).body).toMatchObject({observations:'unknown',usage:null,modelDurationMs:null});
  expect((await post('/ask/answers/cancel',command({requestId:cancelledId,expectedVersion:1}))).status).toBe(200);
  expect((await post('/ask/answers/diagnostics',{requestId:cancelledId})).body).toMatchObject({error:'processing_cancelled',cancelledAt:expect.any(String),completedSteps:0});
  const created=await post('/ask/sessions/create',command({scope:{kind:'firm',firmId}}));expect(created.status).toBe(200);const sessionId=(created.body as {result:{sessionId:string}}).result.sessionId;
  const first=await post('/ask/sessions/turn',command({sessionId,version:1,question:'What repair needs were discussed?'}));expect(first.status).toBe(200);const requestId=(first.body as {result:{requestId:string}}).result.requestId;
  expect((await runOnce(db,{registry,owner:'ordinary-sdk-history',limit:20})).failed).toBe(0);
  const answer=askAnswerReadResultSchema.parse((await post('/ask/answers/read',{requestId})).body);
  expect(answer,JSON.stringify({answer,prompt:observedPrompts.at(-1)})).toMatchObject({state:'complete',progress:{completedSteps:3},answer:{resultVersion:'agent_v1',claims:[{kind:'fact',verification:'cited_unverified'}],coverage:{acquisition:'unverified'}}});expect(calls).toBe(3);
  const diagnostics=await post('/ask/answers/diagnostics',{requestId});expect(diagnostics.status).toBe(200);
  expect(diagnostics.body).toMatchObject({state:'complete',completedSteps:3,observations:'observed',requestedToolNames:['search_history','read_conversation'],executedToolNames:['search_history','read_conversation'],usage:{inputTokens:150,outputTokens:30},cost:{reservedCents:expect.any(Number),settledCents:expect.any(Number)},configurations:[{modelVersion:provider==='bedrock'?route.modelVersion:'gemini-3.8-flash',configFingerprint:expect.any(String)}]});
  expect(JSON.stringify(diagnostics.body)).not.toContain(text);expect(JSON.stringify(diagnostics.body)).not.toContain('opaque-history-step');expect(JSON.stringify(answer)).not.toContain('opaque-history-step');
  expect((await post('/ask/answers/diagnostics',{requestId:randomUUID()})).status).toBe(404);
  const otherToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;expect((await post('/ask/answers/diagnostics',{requestId},otherToken)).status).toBe(404);
  const citation=answer.answer!.claims[0]!.citationWindowIds[0]!;
  expect((await post('/ask/answers/source/read',{requestId,expectedVersion:1,windowId:citation})).body).toMatchObject({source:{passage:{text}}});
  const follow=await post('/ask/sessions/turn',command({sessionId,version:2,question:'And what about speed?'}));expect(follow.status).toBe(200);
  const followId=(follow.body as {result:{requestId:string}}).result.requestId;
  expect((await runOnce(db,{registry,owner:'ordinary-sdk-followup',limit:20})).failed).toBe(0);
  expect((await post('/ask/answers/read',{requestId:followId})).body).toMatchObject({state:'complete'});
  expect(observedPrompts.at(-1)).toContain('What repair needs were discussed?');
  // Explicit expansion is required and clears continuity outside the newly chosen scope.
  expect((await post('/ask/sessions/change',command({sessionId,version:3,action:{kind:'scope',scope:{kind:'business'},confirmExpansion:false}}))).status).toBe(409);
  expect((await post('/ask/sessions/change',command({sessionId,version:3,action:{kind:'scope',scope:{kind:'business'},confirmExpansion:true}}))).status).toBe(200);
  expect((await post('/ask/sessions/read',{sessionId})).body).toMatchObject({version:4,scope:{kind:'business'}});
  const emptyFirm=await seedFirm(fixture,{name:'Repeated Example',assignedUserId:fixture.alpha.admin.userId});await seedFirm(fixture,{name:'Repeated Example',assignedUserId:fixture.alpha.admin.userId});
  expect((await post('/ask/sessions/change',command({sessionId,version:4,action:{kind:'scope',scope:{kind:'firm',firmId:emptyFirm},confirmExpansion:false}}))).status).toBe(200);
  expect((await post('/ask/sessions/read',{sessionId})).body).toMatchObject({version:5,turns:[]});
  const ambiguous=await post('/ask/answers/request',command({question:'Resolve repeated name',execution:'agent_v1',agentScope:{kind:'business'},scope:{sources:[]}}));expect(ambiguous.status).toBe(200);
  const ambiguousId=(ambiguous.body as {result:{requestId:string}}).result.requestId;
  expect((await runOnce(db,{registry,owner:'ordinary-sdk-ambiguous',limit:20})).failed).toBe(0);
  expect((await post('/ask/answers/read',{requestId:ambiguousId})).body).toMatchObject({state:'unavailable',reason:'identity_clarification_required',clarification:{kind:'identity_ambiguous',matches:expect.any(Array)},answer:null});
  expect((await post('/ask/answers/diagnostics',{requestId:ambiguousId})).body).toMatchObject({requestedToolNames:['resolve_records'],executedToolNames:['resolve_records'],completedSteps:1});
  expect((await post('/crm/imports/delete',command({sourceId:imported.source.sourceId,expectedSourceRevision:1,expectedMetadataRevision:1}))).status).toBe(200);
  expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'stale',question:null,answer:null,fallback:null});
  expect((await post('/ask/sessions/read',{sessionId})).body).toMatchObject({turns:[]});
  const erasedDiagnostics=await post('/ask/answers/diagnostics',{requestId});expect(erasedDiagnostics.status).toBe(200);expect(erasedDiagnostics.body).toMatchObject({state:'stale',coverage:null});expect(JSON.stringify(erasedDiagnostics.body)).not.toContain('repairs');
  expect((await post('/ask/answers/source/read',{requestId,expectedVersion:1,windowId:citation})).status).toBe(404);
 }finally{await fixture.stop();}
});

it.each(['bedrock','vertex'] as const)('uses the configured %s SDK to publish and retain a source-free exact-only session answer',async provider=>{
 const fixture=await createAuthFixture();try{
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-sonnet-4-6' as const,providerKey:'controlled.ask_sdk',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z',agentLimits:{maxSteps:4,maxInputBytes:50000,maxOutputTokens:1000,deadlineMs:60000}};
  const {db,post,command,saveDisabledPurpose,composeWorker}=await configuredAskFixture(fixture,provider==='bedrock'?route:{...route,provider:'google_vertex',region:'us',projectId:'synthetic-ask-project',endpointId:'vertex.us/synthetic-ask-project',modelVersion:'gemini-3.8-flash'});
  const firmId=await seedFirm(fixture,{name:'Exact-only firm',assignedUserId:fixture.alpha.admin.userId});
  expect((await saveDisabledPurpose('b'.repeat(64))).status).toBe(200);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-synthetic-contract-only',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let calls=0;
  const model=new MockLanguageModelV3({doGenerate:async()=>{
   calls++;const read=calls===1;
   return {content:[read?{type:'tool-call' as const,toolCallId:'current-opportunities',toolName:'read_exact',input:JSON.stringify({operation:'opportunities',firmId})}:{type:'tool-call' as const,toolCallId:'final',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'There are no open opportunities recorded for this firm.',kind:'fact',citationWindowIds:[],exactResultToolCallIds:['e1']}],abstained:false})}],finishReason:{unified:'tool-calls' as const,raw:'tool_use'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
  }});
  const registry=await composeWorker(model);
  const created=await post('/ask/sessions/create',command({scope:{kind:'firm',firmId}}));expect(created.status).toBe(200);const sessionId=(created.body as {result:{sessionId:string}}).result.sessionId;
  const turn=await post('/ask/sessions/turn',command({sessionId,version:1,question:'How many open opportunities are recorded?'}));expect(turn.status).toBe(200);const requestId=(turn.body as {result:{requestId:string}}).result.requestId;
  expect((await runOnce(db,{registry,owner:'ordinary-sdk-exact-only',limit:20})).failed).toBe(0);
  expect((await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body).toMatchObject({state:'complete',answer:{claims:[{text:'There are no open opportunities recorded for this firm.',citationWindowIds:[],exactResultToolCallIds:['current-opportunities']}],abstained:false}});
  expect((await post('/ask/sessions/read',{sessionId,includeExactResultCitations:true})).body).toMatchObject({turns:[{state:'complete',answer:{claims:[{citationWindowIds:[],exactResultToolCallIds:['current-opportunities']}]}}]});
  expect((await post('/ask/sessions/list',{includeExactResultCitations:true})).body).toMatchObject({sessions:[{turns:[{state:'complete'}]}]});
  expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'unavailable',answer:null});
  expect((await post('/ask/sessions/read',{sessionId})).body).toMatchObject({turns:[{state:'unavailable',answer:null}]});
  expect((await post('/ask/sessions/list',{})).body).toMatchObject({sessions:[{turns:[{state:'unavailable',answer:null}]}]});
  expect((await post('/ask/actions/create',command({requestId,expectedVersion:1,finding:{kind:'answer_claim',index:0},action:{kind:'task',label:'Review exact state',due:null,target:{kind:'firm',firmId}}}))).status).not.toBe(200);
  expect((await post('/ask/answers/diagnostics',{requestId})).body).toMatchObject({usage:{inputTokens:100,outputTokens:20},cost:{unsettledCents:0,estimated:false}});
 }finally{await fixture.stop();}
});
