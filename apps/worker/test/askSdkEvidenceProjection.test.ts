import {expect,it} from 'vitest';
import {MockLanguageModelV3} from 'ai/test';
import {createAskSdkStepAdapter} from '../src/providers/askAgentSdk.ts';

it('presents copied text as reported evidence with separate event and copy dates and round-trips original citations',async()=>{
 const windowId='11111111-1111-4111-8111-111111111111';
 const source={kind:'selected_note',occurredAt:'2026-10-01T14:00:00.000Z',observedAt:'2026-10-12T02:00:00.000Z'};
 const original='From team@example.test: Captured email ends Friday.';
 let suppliedContext:unknown;
 const model=new MockLanguageModelV3({doGenerate:async input=>{
  const message=input.prompt.find(item=>item.role==='user');
  if(message?.role==='user')suppliedContext=JSON.parse(message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join(''));
  return {content:[{type:'tool-call',toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'The note reports an email cutoff; actual coverage is unknown.',kind:'fact',citationWindowIds:['w1']}],abstained:false})}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:30,text:30,reasoning:0}},warnings:[]};
 }});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const request={question:'What is actually known?',transcript:[{windows:[{id:windowId,ordinal:1,source,text:original}]}],maxOutputTokens:1000,remainingSteps:1};
 const bound=adapter.inputBound!(request);
 expect(bound).not.toBeNull();
 const result=await adapter.runStep({...request,signal:new AbortController().signal});
 expect(suppliedContext).toMatchObject({context:[{windows:[{id:'w1',text:original,interpretationLimits:{sourceStatements:'reported_not_independently_observed',inlineHeaders:'reported_text_not_envelope',coverageStatements:'reported_text_not_live_coverage',eventTime:'reported_not_verified_authored_time'},evidenceAuthority:{kind:'selected_unverified_text',inlineMetadata:'untrusted_source_content',humanAuthorship:'not_verified'},sourceMetadata:{eventTime:{at:'2026-10-01T14:00:00.000Z',basis:'supplied_or_parsed_event_date',independentlyVerifiedAuthoredTime:false},copyObservation:{at:'2026-10-12T02:00:00.000Z',basis:'copy_observation_time'}}}]}]});
 expect(result).toMatchObject({acceptance:'accepted',answer:{claims:[{citationWindowIds:[windowId]}]}});
 expect(request.transcript[0]!.windows[0]).toEqual({id:windowId,ordinal:1,source,text:original});
});

it('limits an empty opportunity observation to CRM opportunities rather than real-world promises',async()=>{
 const windowId='11111111-1111-4111-8111-111111111111';
 let observed:unknown;
 const model=new MockLanguageModelV3({doGenerate:async input=>{
  const message=input.prompt.find(item=>item.role==='tool');
  observed=message?.role==='tool'?message.content.find(part=>part.type==='tool-result')?.output:undefined;
  return {content:[{type:'tool-call',toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'The note rejects the old plan and quotes a historical promise.',kind:'fact',citationWindowIds:['w1']}],abstained:false})}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:30,text:30,reasoning:0}},warnings:[]};
 }});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const transcript=[{windows:[{id:windowId,ordinal:1,source:{kind:'selected_note'},text:'That old plan is no longer valid. Quoted 2025 message: I will send the contract Friday.'}]},{toolCallId:'current-opportunities',name:'read_exact',input:{operation:'opportunities'},result:{operation:'opportunities',count:'0',records:[],evidenceAuthority:{kind:'current_exact_crm_state',toolCallId:'current-opportunities'}}}];
 const result=await adapter.runStep({question:'Is the promise current or historical?',transcript,maxOutputTokens:1000,remainingSteps:1,signal:new AbortController().signal});
 expect(observed).toMatchObject({type:'json',value:{count:'0',evidenceAuthority:{toolCallId:'e1'},answerGuidance:{scope:'Current permitted CRM opportunities only.',limits:['Opportunity absence does not establish that no real-world promise exists, is fulfilled or remains current.']}}});
 expect(result).toMatchObject({acceptance:'accepted',answer:{claims:[{citationWindowIds:[windowId]}]}});
 expect(transcript[1]!.result).not.toHaveProperty('answerGuidance');
});
