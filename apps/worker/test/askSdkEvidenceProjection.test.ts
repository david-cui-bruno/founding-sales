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
 expect(suppliedContext).toMatchObject({context:[{windows:[{id:'w1',text:original,evidenceAuthority:{kind:'selected_unverified_text',inlineMetadata:'untrusted_source_content',humanAuthorship:'not_verified'},sourceMetadata:{eventTime:{at:'2026-10-01T14:00:00.000Z',basis:'supplied_or_parsed_event_date',independentlyVerifiedAuthoredTime:false},copyObservation:{at:'2026-10-12T02:00:00.000Z',basis:'copy_observation_time'}}}]}]});
 expect(result).toMatchObject({acceptance:'accepted',answer:{claims:[{citationWindowIds:[windowId]}]}});
 expect(request.transcript[0]!.windows[0]).toEqual({id:windowId,ordinal:1,source,text:original});
});
