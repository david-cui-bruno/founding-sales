import {expect,it} from 'vitest';
import {z} from 'zod';
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
 const model=createAmazonBedrock({region:'us-east-1',credentialProvider:async()=>({accessKeyId:'controlled',secretAccessKey:'controlled'}),fetch:async(_url,init)=>{request=JSON.parse(String(init?.body));providerCalls++;return new Response(JSON.stringify({output:{message:{role:'assistant',content:providerCalls===1?[{toolUse:{toolUseId:'read-1',name:'read_exact',input:{operation:'reply_status'}}}]:[{toolUse:{toolUseId:'final-1',name:'emit_answer',input:{claims:[],abstained:true}}}]}},stopReason:'tool_use',usage:{inputTokens:30,outputTokens:10,totalTokens:40},metrics:{latencyMs:1}}),{headers:{'content-type':'application/json'}});}})('us.anthropic.claude-haiku-4-5-20251001-v1:0');
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const input={question:'What is supported?',transcript:[],maxOutputTokens:1000};
 expect(await adapter.runStep({...input,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',answer:null,toolCalls:[{id:'read-1',name:'read_exact',input:{operation:'reply_status'}}],usage:{inputTokens:30,outputTokens:10}});
 const finalInput={...input,transcript:[{toolCallId:'read-1',name:'read_exact',input:{operation:'reply_status'},result:{records:[],coverage:{partial:true}}}]};
 expect(await adapter.runStep({...finalInput,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',answer:{claims:[],abstained:true},toolCalls:[],usage:{inputTokens:30,outputTokens:10}});
 expect(request).toMatchObject({toolConfig:{toolChoice:{any:{}}}});
 const parsed=JSON.parse(JSON.stringify(request)) as {toolConfig:{tools:{toolSpec:{name:string}}[]};additionalModelRequestFields?:unknown};
 expect(parsed.toolConfig.tools.map(tool=>tool.toolSpec.name).sort()).toEqual(['browse_history','emit_answer','read_conversation','read_exact','read_selected','resolve_records','search_history','search_selected']);
 expect(parsed.toolConfig.tools.find(tool=>tool.toolSpec.name==='emit_answer')).toMatchObject({toolSpec:{strict:true,inputSchema:{json:{properties:{claims:{description:expect.stringContaining('Mixed original and exact CRM facts'),items:{properties:{text:{description:expect.stringContaining('Each factual clause')},citationWindowIds:{description:expect.stringContaining('SQL clauses additionally need')}}}}}}}}});
 expect(JSON.stringify(parsed.toolConfig.tools.find(tool=>tool.toolSpec.name==='emit_answer'))).toContain('exactResultToolCallIds');
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
 const model=createAmazonBedrock({region:'us-east-1',credentialProvider:async()=>({accessKeyId:'controlled',secretAccessKey:'controlled'}),fetch:async(_url,init)=>{calls++;request=JSON.parse(String(init?.body));return new Response(JSON.stringify({output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'final',name:'emit_answer',input:{claims:[],abstained:true}}}]}},stopReason:'tool_use',usage:{inputTokens:30,outputTokens:10,totalTokens:40},metrics:{latencyMs:1}}),{headers:{'content-type':'application/json'}});}})('us.anthropic.claude-haiku-4-5-20251001-v1:0');
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const input={question:'What is supported?',transcript:[{toolCallId:'read-1',name:'read_exact',input:{operation:'tasks'},result:{records:[],coverage:{partial:true}}}],maxOutputTokens:1000,remainingSteps:1};
 expect(await adapter.runStep({...input,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',answer:{claims:[],abstained:true},toolCalls:[]});
 expect(request).toMatchObject({toolConfig:{tools:[{toolSpec:{name:'emit_answer',strict:true}}],toolChoice:{tool:{name:'emit_answer'}}}});
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
it.each([
 {label:'one strict data output',content:[{type:'tool-call' as const,toolCallId:'output-1',toolName:'emit_answer',input:'{"claims":[],"abstained":true}'}],answer:{claims:[],abstained:true}},
 {label:'malformed nested-string output',content:[{type:'tool-call' as const,toolCallId:'output-1',toolName:'emit_answer',input:'{"claims":"[]","abstained":true}'}],answer:null},
 {label:'multiple final outputs',content:[{type:'tool-call' as const,toolCallId:'output-1',toolName:'emit_answer',input:'{"claims":[],"abstained":true}'},{type:'tool-call' as const,toolCallId:'output-2',toolName:'emit_answer',input:'{"claims":[],"abstained":true}'}],answer:null},
 {label:'mixed final output and readonly request',content:[{type:'tool-call' as const,toolCallId:'output-1',toolName:'emit_answer',input:'{"claims":[],"abstained":true}'},{type:'tool-call' as const,toolCallId:'read-1',toolName:'read_exact',input:'{"operation":"tasks"}'}],answer:null},
])('handles $label as output data only while conserving observed usage',async example=>{
 const model=new MockLanguageModelV3({doGenerate:async()=>({content:example.content,finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:52,noCache:52,cacheRead:0,cacheWrite:0},outputTokens:{total:24,text:24,reasoning:0}},warnings:[]})});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 expect(await adapter.runStep({question:'Synthetic?',transcript:[],maxOutputTokens:64,signal:new AbortController().signal})).toEqual({acceptance:'accepted',usage:{inputTokens:52,outputTokens:24},answer:example.answer,toolCalls:[]});
});
it('keeps known and unknown billing isolated when the same adapter runs concurrent final generations',async()=>{
 let ready=0;let release=()=>{};const barrier=new Promise<void>(resolve=>{release=resolve;});
 const model=new MockLanguageModelV3({doGenerate:async input=>{const cachedWrite=JSON.stringify(input.prompt).includes('cache-write-call');ready++;if(ready===2)release();await barrier;return {content:[{type:'text',text:'{"claims":[],"abstained":true}'}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:cachedWrite?53:52,noCache:52,cacheRead:0,cacheWrite:cachedWrite?1:0},outputTokens:{total:24,text:24,reasoning:0}},warnings:[]};}});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const results=await Promise.all(['known-plain-call','cache-write-call'].map(question=>adapter.runStep({question,transcript:[],remainingSteps:1,maxOutputTokens:64,signal:new AbortController().signal})));
 expect(results[0]).toEqual({acceptance:'accepted',usage:{inputTokens:52,outputTokens:24},answer:{claims:[],abstained:true},toolCalls:[]});
 expect(results[1]).toEqual({acceptance:'unknown',usage:null,answer:null,toolCalls:[]});expect(ready).toBe(2);
});
it('sends only supported strict-tool schema keywords through the real Bedrock SDK wire',async()=>{
 const {createAmazonBedrock}=await import('@ai-sdk/amazon-bedrock');let calls=0;let rejected:string[]=[];let observedRequest:unknown;
 const unsupported=(value:unknown):string[]=>{if(Array.isArray(value))return value.flatMap(unsupported);if(value===null||typeof value!=='object')return [];return Object.entries(value).flatMap(([key,child])=>['minLength','maxLength','maxItems','minimum','maximum','multipleOf'].includes(key)||key==='minItems'&&child!==0&&child!==1?[key]:unsupported(child));};
 const model=createAmazonBedrock({region:'us-east-1',credentialProvider:async()=>({accessKeyId:'controlled',secretAccessKey:'controlled'}),fetch:async(_url,init)=>{
  calls++;observedRequest=JSON.parse(String(init?.body));const request=z.object({toolConfig:z.object({tools:z.array(z.object({toolSpec:z.object({strict:z.boolean().optional(),inputSchema:z.object({json:z.unknown()})})}))})}).parse(observedRequest);rejected=request.toolConfig.tools.flatMap(tool=>tool.toolSpec.strict===true?unsupported(tool.toolSpec.inputSchema.json):[]);
  // AWS documents immediate HTTP400 for unsupported strict schema keywords.
  if(rejected.length)return new Response(JSON.stringify({message:'Unsupported strict JSON schema constraints'}),{status:400,headers:{'content-type':'application/json','x-amzn-errortype':'ValidationException'}});
  return new Response(JSON.stringify({output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'final',name:'emit_answer',input:{claims:[],abstained:true}}}]}},stopReason:'tool_use',usage:{inputTokens:30,outputTokens:10,totalTokens:40},metrics:{latencyMs:1}}),{headers:{'content-type':'application/json'}});
 }})('us.anthropic.claude-sonnet-4-6');
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});const input={question:'Synthetic?',transcript:[],remainingSteps:1,maxOutputTokens:1000};
 expect(await adapter.runStep({...input,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',answer:{claims:[],abstained:true},toolCalls:[],usage:{inputTokens:30,outputTokens:10}});expect(rejected).toEqual([]);expect(calls).toBe(1);expect(adapter.inputBound!(input)!.inputBytes).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(observedRequest)));
});
it('keeps an actual SDK HTTP400 without reported usage unknown and never retries it',async()=>{
 const {createAmazonBedrock}=await import('@ai-sdk/amazon-bedrock');let calls=0;
 const model=createAmazonBedrock({region:'us-east-1',credentialProvider:async()=>({accessKeyId:'controlled',secretAccessKey:'controlled'}),fetch:async()=>{calls++;return new Response(JSON.stringify({message:'Unsupported schema'}),{status:400,headers:{'content-type':'application/json','x-amzn-errortype':'ValidationException'}});}})('us.anthropic.claude-sonnet-4-6');
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});expect(await adapter.runStep({question:'Synthetic?',transcript:[],remainingSteps:1,maxOutputTokens:1000,signal:new AbortController().signal})).toEqual({acceptance:'unknown',usage:null,answer:null,toolCalls:[]});expect(calls).toBe(1);
});
it('round-trips short original and exact citation handles through the real SDK without changing canonical evidence',async()=>{
 const {createAmazonBedrock}=await import('@ai-sdk/amazon-bedrock');const windowId='05817032-268c-4647-989d-43398e32fbd7';const sourceId='08f0a939-4961-420e-a70c-06c69d101daa';let calls=0;let body='';
 const model=createAmazonBedrock({region:'us-east-1',credentialProvider:async()=>({accessKeyId:'controlled',secretAccessKey:'controlled'}),fetch:async(_url,init)=>{calls++;body=String(init?.body);return new Response(JSON.stringify({output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'response',name:calls===1?'read_selected':'emit_answer',input:calls===1?{windowIds:['w7']}:{claims:[{text:'A supported mixed interpretation.',kind:'inference',citationWindowIds:['w7'],exactResultToolCallIds:['e1']}],abstained:false}}}]}},stopReason:'tool_use',usage:{inputTokens:30,outputTokens:10,totalTokens:40},metrics:{latencyMs:1}}),{headers:{'content-type':'application/json'}});}})('us.anthropic.claude-sonnet-4-6');
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const input={question:'What is supported?',transcript:[{windows:[{id:windowId,ordinal:7,source:{kind:'selected_note',sourceId},text:'Original evidence.',evidenceAuthority:{kind:'selected_unverified_text'}}]},{toolCallId:'actual-exact-call',name:'read_exact',input:{operation:'tasks'},result:{count:'1',evidenceAuthority:{kind:'current_exact_crm_state',toolCallId:'actual-exact-call',citationAuthority:'exact_result_only'}}}],maxOutputTokens:1000};
 expect(await adapter.runStep({...input,remainingSteps:2,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',toolCalls:[{name:'read_selected',input:{windowIds:[windowId]}}]});expect(body).toContain('w7');expect(body).not.toContain(windowId);
 const last={...input,remainingSteps:1};expect(await adapter.runStep({...last,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',answer:{claims:[{citationWindowIds:[windowId],exactResultToolCallIds:['actual-exact-call']}]},toolCalls:[]});expect(adapter.inputBound!(last)!.inputBytes).toBeGreaterThanOrEqual(Buffer.byteLength(body));expect(calls).toBe(2);
});
it('maps identical short handles privately for concurrent calls and never borrows parent-history citation authority',async()=>{
 const first='05817032-268c-4647-989d-43398e32fbd7',second='15928043-379d-4758-989d-43398e32fbd7',parent='26939054-48ae-4869-989d-43398e32fbd7';
 const model=new MockLanguageModelV3({doGenerate:async()=>({content:[{type:'tool-call',toolCallId:'out',toolName:'emit_answer',input:'{"claims":[{"text":"Evidence.","kind":"fact","citationWindowIds":["w1"]}],"abstained":false}'}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:52,noCache:52,cacheRead:0,cacheWrite:0},outputTokens:{total:24,text:24,reasoning:0}},warnings:[]})});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const results=await Promise.all([first,second].map(id=>adapter.runStep({question:'Evidence?',transcript:[{history:{windows:[{id:parent,ordinal:1,source:{kind:'selected_note'},text:'Parent-only history.',evidenceAuthority:{kind:'selected_unverified_text'}}]}},{windows:[{id,ordinal:1,source:{kind:'selected_note'},text:'Current evidence.',evidenceAuthority:{kind:'selected_unverified_text'}}]}],remainingSteps:1,maxOutputTokens:64,signal:new AbortController().signal})));
 expect(results[0]).toMatchObject({answer:{claims:[{citationWindowIds:[first]}]}});expect(results[1]).toMatchObject({answer:{claims:[{citationWindowIds:[second]}]}});
});
it('keeps short handles stable when later server tool results add windows and leaves unknown citations invalid',async()=>{
 const old='05817032-268c-4647-989d-43398e32fbd7',fresh='15928043-379d-4758-989d-43398e32fbd7';
 let seen='';const model=new MockLanguageModelV3({doGenerate:async input=>{seen=JSON.stringify(input.prompt);return {content:[{type:'tool-call',toolCallId:'out',toolName:'emit_answer',input:'{"claims":[{"text":"Evidence.","kind":"fact","citationWindowIds":["w7","w11","w999","05817032-268c-4aa-989d-43398e32fbd7"],"exactResultToolCallIds":["e2","e999"]}],"abstained":false}'}],finishReason:{unified:'tool-calls',raw:'tool_use'},usage:{inputTokens:{total:52,noCache:52,cacheRead:0,cacheWrite:0},outputTokens:{total:24,text:24,reasoning:0}},warnings:[]};}});
 const window=(id:string,ordinal:number)=>({id,ordinal,source:{kind:'selected_note'},text:'Evidence.',evidenceAuthority:{kind:'selected_unverified_text'}});
 const exact=(id:string)=>({toolCallId:id,name:'read_exact',input:{operation:'tasks'},result:{evidenceAuthority:{kind:'current_exact_crm_state',toolCallId:id}}});
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 const result=await adapter.runStep({question:'Evidence?',transcript:[{windows:[window(old,7)]},exact('first-exact'),{toolCallId:'browse',name:'browse_history',input:{limit:2},result:{windows:[window(fresh,11),window(old,7)]}},exact('second-exact')],remainingSteps:1,maxOutputTokens:64,signal:new AbortController().signal});
 expect(result).toMatchObject({answer:{claims:[{citationWindowIds:[old,fresh,'w999','05817032-268c-4aa-989d-43398e32fbd7'],exactResultToolCallIds:['second-exact','e999']}]}});expect(seen).toContain('w7');expect(seen).toContain('w11');expect(seen).not.toContain(old);expect(seen).not.toContain(fresh);
});
