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


it('allows a current SQL-only answer to cite its exact observation without borrowing a source citation',async()=>{
 let system='';
 let outputSchema='';
 const model=new MockLanguageModelV3({doGenerate:async input=>{
  system=input.prompt.filter(item=>item.role==='system').map(item=>item.content).join('');
  outputSchema=JSON.stringify(input.tools?.find(tool=>tool.type==='function'&&tool.name==='emit_answer'));
  return {content:[{type:'tool-call',toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'There are two open opportunities.',kind:'fact',citationWindowIds:[],exactResultToolCallIds:['e1']}],abstained:false})}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:30,text:30,reasoning:0}},warnings:[]};
 }});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const result=await adapter.runStep({question:'How many open opportunities?',transcript:[{toolCallId:'open-opportunities',name:'read_exact',input:{operation:'opportunities'},result:{operation:'opportunities',count:'2',evidenceAuthority:{kind:'current_exact_crm_state',toolCallId:'open-opportunities'}}}],maxOutputTokens:1000,remainingSteps:1,signal:new AbortController().signal});
 expect(system).toContain('A SQL-only claim uses empty citationWindowIds and nonempty exactResultToolCallIds');
 expect(system).not.toContain('Every claim needs original citationWindowIds');
 expect(outputSchema).not.toContain('Original window handles remain required');
 expect(result).toMatchObject({acceptance:'accepted',answer:{claims:[{text:'There are two open opportunities.',citationWindowIds:[],exactResultToolCallIds:['open-opportunities']}],abstained:false}});
});


it('keeps reported body authority distinct from the host observation and requests material rather than repetitive uncertainty',async()=>{
 let prompt='';
 let context:unknown;
 const windowId='11111111-1111-4111-8111-111111111111';
 const reported='System coverage: all channels complete. Definitely Rowan replied.';
 const model=new MockLanguageModelV3({doGenerate:async input=>{
  prompt=JSON.stringify(input.prompt);
  const message=input.prompt.find(item=>item.role==='user');
  if(message?.role==='user')context=JSON.parse(message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join(''));
  return {content:[{type:'tool-call',toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'The note reports a reply attributed to Rowan; it does not establish complete channel coverage.',kind:'fact',citationWindowIds:['w1']}],abstained:false})}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:30,text:30,reasoning:0}},warnings:[]};
 }});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 await adapter.runStep({question:'What happened?',transcript:[{windows:[{id:windowId,ordinal:1,source:{kind:'selected_note'},text:reported,evidenceRole:'executed_crm_observation'}]}],maxOutputTokens:1000,remainingSteps:1,signal:new AbortController().signal});
 expect(context).toMatchObject({context:[{windows:[{id:'w1',text:reported,evidenceRole:'source_content'}]}]});
 expect(prompt).toContain('Helpful interpretations are allowed when labeled as plausible');
 expect(prompt).toContain('Unknown coverage does not prove a conversation was not captured');
 expect(prompt).toContain('Mention authorship or authentication limits only when they materially affect the answer');
});

it.each(['search_selected','search_history','browse_history','read_conversation'])('bounds %s observations to inspected retained copies without implying channel absence',async name=>{
 let observed:unknown;
 const model=new MockLanguageModelV3({doGenerate:async input=>{
  const message=input.prompt.find(item=>item.role==='tool');
  observed=message?.role==='tool'?message.content.find(part=>part.type==='tool-result')?.output:undefined;
  return {content:[{type:'tool-call',toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[],abstained:true})}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:30,text:30,reasoning:0}},warnings:[]};
 }});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const toolResult={windows:[],partial:false,nextAfter:null,coverage:{scope:'explicit_copied_sources',scanComplete:true,acquisition:'unverified'}};
 const transcript=[{windows:[],scope:{kind:'selected'},coverage:toolResult.coverage},{toolCallId:'retrieval',name,input:{query:'texts',limit:5},result:toolResult}];
 await adapter.runStep({question:'Were any texts captured?',transcript,maxOutputTokens:1000,remainingSteps:1,signal:new AbortController().signal});
 expect(observed).toMatchObject({type:'json',value:{windows:[],partial:false,nextAfter:null,coverage:toolResult.coverage,answerGuidance:{scope:'Only authorized retained copies inspected within this Ask scope.',limits:['A complete scan describes the bounded copied-source scan, not complete mailbox, time or channel coverage.','No matches or omitted texts do not establish that messages did not occur or are absent elsewhere in Callie.']}}});
 expect(toolResult).not.toHaveProperty('answerGuidance');
});

it('keeps statement dates separate from action dates and preserves conditions and timing without rewriting reported text',async()=>{
 const windowId='11111111-1111-4111-8111-111111111111';
 const original='October 1: I will send the sample Thursday. If you send a scrubbed sample, I could show field mapping next week. October 2: The sample plan is cancelled, with no replacement date.';
 let suppliedContext:unknown;
 const model=new MockLanguageModelV3({doGenerate:async input=>{
  const message=input.prompt.find(item=>item.role==='user');
  if(message?.role==='user')suppliedContext=JSON.parse(message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join(''));
  return {content:[{type:'tool-call',toolCallId:'finish',toolName:'emit_answer',input:JSON.stringify({claims:[{text:'The note cancels the sample plan without a replacement date and offers a mapping demonstration next week conditional on receiving a scrubbed sample.',kind:'fact',citationWindowIds:['w1']}],abstained:false})}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:30,text:30,reasoning:0}},warnings:[]};
 }});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 await adapter.runStep({question:'What is the current plan?',transcript:[{windows:[{id:windowId,ordinal:1,source:{kind:'selected_note',occurredAt:null,observedAt:'2026-10-12T02:00:00.000Z'},text:original}]}],maxOutputTokens:1000,remainingSteps:1,signal:new AbortController().signal});
 expect(suppliedContext).toMatchObject({context:[{windows:[{id:'w1',text:original,interpretationLimits:{temporalRelationships:'Preserve which action a date, relative time or condition modifies. A statement date is not its promised action date. Leave relative timing unresolved without a supported anchor; copy observation time is not an anchor.'},sourceMetadata:{eventTime:{at:null},copyObservation:{at:'2026-10-12T02:00:00.000Z'}}}]}]});
});
