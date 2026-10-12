import {expect,it} from 'vitest';
import {MockLanguageModelV3} from 'ai/test';
import {createAskSdkStepAdapter} from '../src/providers/askAgentSdk.ts';
it('counts the same actual SDK system/tools/encoded messages before provider dispatch',async()=>{
 let actualBytes=0;
 const model=new MockLanguageModelV3({doGenerate:async input=>{actualBytes=Buffer.byteLength(JSON.stringify(input));return {content:[{type:'text',text:'{"claims":[],"abstained":true}'}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:30,noCache:30,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};}});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const request={question:'Current state?',transcript:[{windows:[{text:'😀 Original text. "Quoted"'}],coverage:{partial:true}},{toolCallId:'read-1',name:'read_exact',input:{operation:'tasks'},result:{records:[],coverage:{partial:true}}}],maxOutputTokens:1000};
 const bound=adapter.inputBound?.(request);expect(bound).not.toBeNull();expect(actualBytes).toBe(0);
 expect(await adapter.runStep({...request,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted'});
 expect(bound!.inputBytes).toBeGreaterThanOrEqual(actualBytes);expect(bound!.maxInputTokens).toBeGreaterThanOrEqual(actualBytes);
 const larger=adapter.inputBound?.({...request,transcript:[{windows:[{text:'😀'.repeat(1000)}]},...request.transcript.slice(1)]});expect(larger!.inputBytes).toBeGreaterThan(bound!.inputBytes);
});
it('refuses unencodable input before dispatch',()=>{
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model:new MockLanguageModelV3()});
 expect(adapter.inputBound?.({question:'BigInt is not a JSON transcript',transcript:[{unsupported:1n}],maxOutputTokens:100})).toBeNull();
});
it('requests SDK schema-bound final output while preserving retrieval tools and the complete input bound',async()=>{
 const {createAmazonBedrock}=await import('@ai-sdk/amazon-bedrock');let request:Record<string,unknown>|null=null;let providerCalls=0;
 const model=createAmazonBedrock({region:'us-east-1',credentialProvider:async()=>({accessKeyId:'controlled',secretAccessKey:'controlled'}),fetch:async(_url,init)=>{request=JSON.parse(String(init?.body));providerCalls++;return new Response(JSON.stringify({output:{message:{role:'assistant',content:providerCalls===1?[{toolUse:{toolUseId:'read-1',name:'read_exact',input:{operation:'reply_status'}}}]:[{toolUse:{toolUseId:'final-1',name:'json',input:{claims:[],abstained:true}}}]}},stopReason:'tool_use',usage:{inputTokens:30,outputTokens:10,totalTokens:40},metrics:{latencyMs:1}}),{headers:{'content-type':'application/json'}});}})('us.anthropic.claude-haiku-4-5-20251001-v1:0');
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const input={question:'What is supported?',transcript:[],maxOutputTokens:1000};
 expect(await adapter.runStep({...input,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',answer:null,toolCalls:[{id:'read-1',name:'read_exact',input:{operation:'reply_status'}}],usage:{inputTokens:30,outputTokens:10}});
 const finalInput={...input,transcript:[{toolCallId:'read-1',name:'read_exact',input:{operation:'reply_status'},result:{records:[],coverage:{partial:true}}}]};
 expect(await adapter.runStep({...finalInput,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',answer:{claims:[],abstained:true},toolCalls:[],usage:{inputTokens:30,outputTokens:10}});
 expect(request).toMatchObject({toolConfig:{toolChoice:{any:{}}}});
 const parsed=JSON.parse(JSON.stringify(request)) as {toolConfig:{tools:{toolSpec:{name:string}}[]};additionalModelRequestFields?:unknown};
 expect(parsed.toolConfig.tools.map(tool=>tool.toolSpec.name).sort()).toEqual(['browse_history','json','read_conversation','read_exact','read_selected','resolve_records','search_history','search_selected']);
 expect(JSON.stringify(parsed.toolConfig.tools.find(tool=>tool.toolSpec.name==='json'))).not.toMatch(/"(?:minLength|maxLength|minItems|maxItems|pattern)":/u);
 expect(adapter.inputBound!(finalInput)!.inputBytes).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(request)));
});
it('preserves known billing when an observed prose final answer violates structured output',async()=>{
 const model=new MockLanguageModelV3({doGenerate:async()=>({content:[{type:'text',text:'Based on the exact state query, I cannot provide a definitive answer.\n```json\n{"claims":[{"text":"The reply_status operation returned unanswered","kind":"fact","citationWindowIds":[]}],"abstained":false}\n```'}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:2359,noCache:2359,cacheRead:0,cacheWrite:0},outputTokens:{total:161,text:161,reasoning:0}},warnings:[]})});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 expect(await adapter.runStep({question:'Was there a reply?',transcript:[],maxOutputTokens:1000,signal:new AbortController().signal})).toEqual({acceptance:'accepted',usage:{inputTokens:2359,outputTokens:161},answer:null,toolCalls:[]});
});
it('keeps legal retrieval-only turns and their known usage without generating a final answer',async()=>{
 const model=new MockLanguageModelV3({doGenerate:async()=>({content:[{type:'text',text:'I will check exact state.'},{type:'tool-call',toolCallId:'read-1',toolName:'read_exact',input:'{"operation":"reply_status"}'}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:200,noCache:200,cacheRead:0,cacheWrite:0},outputTokens:{total:30,text:30,reasoning:0}},warnings:[]})});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 expect(await adapter.runStep({question:'Was there a reply?',transcript:[],maxOutputTokens:1000,signal:new AbortController().signal})).toEqual({acceptance:'accepted',usage:{inputTokens:200,outputTokens:30},answer:null,toolCalls:[{id:'read-1',name:'read_exact',input:{operation:'reply_status'}}]});
});
it('uses only the explicit remaining-step budget for the final-turn instruction and counts it before dispatch',async()=>{
 let prompt='';let actualBytes=0;let calls=0;
 const model=new MockLanguageModelV3({doGenerate:async input=>{calls++;prompt=JSON.stringify(input.prompt);actualBytes=Buffer.byteLength(JSON.stringify(input));return {content:[{type:'text',text:'{"claims":[],"abstained":true}'}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:20,noCache:20,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};}});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const request={question:'What is supported?',transcript:[],maxOutputTokens:1000};
 await adapter.runStep({...request,remainingSteps:2,signal:new AbortController().signal});expect(prompt).not.toContain('last permitted model generation');
 const bound=adapter.inputBound!({...request,remainingSteps:1})!;
 await adapter.runStep({...request,remainingSteps:1,signal:new AbortController().signal});expect(prompt).toContain('last permitted model generation');expect(bound.inputBytes).toBeGreaterThanOrEqual(actualBytes);
 for(const remainingSteps of [0,33,1.5]){expect(adapter.inputBound!({...request,remainingSteps})).toBeNull();expect(await adapter.runStep({...request,remainingSteps,signal:new AbortController().signal})).toMatchObject({acceptance:'not_accepted',usage:{inputTokens:0,outputTokens:0}});}
 expect(calls).toBe(2);
});
it('reserves the last generation for structured synthesis without any external retrieval tool',async()=>{
 const {createAmazonBedrock}=await import('@ai-sdk/amazon-bedrock');let calls=0;let request:unknown;
 const model=createAmazonBedrock({region:'us-east-1',credentialProvider:async()=>({accessKeyId:'controlled',secretAccessKey:'controlled'}),fetch:async(_url,init)=>{calls++;request=JSON.parse(String(init?.body));return new Response(JSON.stringify({output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'final',name:'json',input:{claims:[],abstained:true}}}]}},stopReason:'tool_use',usage:{inputTokens:30,outputTokens:10,totalTokens:40},metrics:{latencyMs:1}}),{headers:{'content-type':'application/json'}});}})('us.anthropic.claude-haiku-4-5-20251001-v1:0');
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const input={question:'What is supported?',transcript:[{toolCallId:'read-1',name:'read_exact',input:{operation:'tasks'},result:{records:[],coverage:{partial:true}}}],maxOutputTokens:1000,remainingSteps:1};
 expect(await adapter.runStep({...input,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',answer:{claims:[],abstained:true},toolCalls:[]});
 expect(request).toMatchObject({toolConfig:{tools:[{toolSpec:{name:'json'}}],toolChoice:{any:{}}}});
 expect((request as {toolConfig:{tools:unknown[]}}).toolConfig.tools).toHaveLength(1);expect(calls).toBe(1);
 expect(request).toMatchObject({additionalModelRequestFields:{thinking:{type:'disabled'}}});
 expect(adapter.inputBound!(input)!.inputBytes).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(request)));
});
it.each([
 {label:'positive cache write',total:51,noCache:50,cacheRead:0,cacheWrite:1},
 {label:'negative cache write',total:50,noCache:50,cacheRead:0,cacheWrite:-1},
 {label:'fractional cache read',total:50,noCache:49.5,cacheRead:0.5,cacheWrite:0},
 {label:'nonfinite cache read',total:50,noCache:50,cacheRead:NaN,cacheWrite:0},
 {label:'inconsistent cache total',total:50,noCache:50,cacheRead:10,cacheWrite:0},
])('conserves unknown billing for SDK $label rather than settling at the ordinary input tariff',async inputUsage=>{
 for(const text of ['{"claims":[],"abstained":true}','Malformed paid final output']){
  const model=new MockLanguageModelV3({doGenerate:async()=>({content:[{type:'text',text}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:inputUsage.total,noCache:inputUsage.noCache,cacheRead:inputUsage.cacheRead,cacheWrite:inputUsage.cacheWrite},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]})});
  const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
  expect(await adapter.runStep({question:'Synthetic?',transcript:[],maxOutputTokens:64,signal:new AbortController().signal})).toEqual({acceptance:'unknown',usage:null,answer:null,toolCalls:[]});
 }
});
it('conservatively bills SDK cached reads using its observed total input count',async()=>{
 const model=new MockLanguageModelV3({doGenerate:async()=>({content:[{type:'text',text:'{"claims":[],"abstained":true}'}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:70,noCache:50,cacheRead:20,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]})});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 expect(await adapter.runStep({question:'Synthetic?',transcript:[],maxOutputTokens:64,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',usage:{inputTokens:70,outputTokens:10}});
});
