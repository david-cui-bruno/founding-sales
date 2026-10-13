import {expect,it} from 'vitest';
import {z} from 'zod';
import {MockLanguageModelV3} from 'ai/test';
import {OAuth2Client} from 'google-auth-library';
import {createVertex} from '@ai-sdk/google-vertex';
import {createAskSdkStepAdapter,createVertexAskSdkStepAdapter} from '../src/providers/askAgentSdk.ts';

const projectId='synthetic-project';
const windowId='11111111-1111-4111-8111-111111111111';
const opportunityId='22222222-2222-4222-8222-222222222222';
const quote='Cancel that Thursday plan because stock is unavailable. I have not agreed to a replacement date.';
const transcript=[
 {windows:[{id:windowId,ordinal:1,source:{kind:'selected_note',speaker:null,occurredAt:null,observedAt:null},text:quote}]},
 {toolCallId:'current-opportunities',name:'read_exact',input:{operation:'opportunities'},modelStep:1,providerMetadata:{vertex:{thoughtSignature:'synthetic-construction-signature'}},result:{operation:'opportunities',count:'1',records:[{opportunityId,name:'North pilot',stageKey:'qualified',status:'open'}],evidenceAuthority:{kind:'current_exact_crm_state',toolCallId:'current-opportunities'}}},
];
const request={question:'What is the latest sample plan?',transcript,maxOutputTokens:1000,remainingSteps:1};
const sourceClaim={text:'No replacement date currently scheduled.',kind:'inference',citationWindowIds:['w1'],exactResultToolCallIds:[],construction:{mode:'source_quote',windowId:'w1',quote}};
const allowedClaims=[sourceClaim,
 {text:'Untrusted count prose',kind:'inference',citationWindowIds:[],exactResultToolCallIds:['e1'],construction:{mode:'exact_count',toolCallId:'e1'}},
 {text:'Untrusted record prose',kind:'conflict',citationWindowIds:[],exactResultToolCallIds:['e1'],construction:{mode:'opportunity_record',toolCallId:'e1',opportunityId}},
];
const legacyClaim={text:'No replacement date currently scheduled.',kind:'fact',citationWindowIds:['w1'],exactResultToolCallIds:[]};
const interpretationClaim={...legacyClaim,construction:{mode:'interpretation',premises:'source'}};
const usage={inputTokens:{total:52,noCache:52,cacheRead:0,cacheWrite:0},outputTokens:{total:24,text:24,reasoning:0}};
const observedUsage={inputTokens:52,outputTokens:24};
const route={projectId,region:'us' as const,endpointId:`vertex.us/${projectId}`,modelVersion:'gemini-3.8-flash' as const,providerKey:'synthetic'};
type Channel='emit'|'json'|'fence';
function controlledRun(answer:unknown,channel:Channel='emit'){
 let calls=0;
 let actualInput:unknown;
 const encoded=JSON.stringify(answer);
 const model=new MockLanguageModelV3({doGenerate:async input=>{
  calls++;actualInput=input;
  return {content:channel==='emit'
   ?[{type:'tool-call' as const,toolCallId:'final',toolName:'emit_answer',input:encoded}]
   :[{type:'text' as const,text:channel==='fence'?`\`\`\`json\n${encoded}\n\`\`\``:encoded}],
   finishReason:{unified:channel==='emit'?'tool-calls' as const:'stop' as const,raw:'STOP'},usage,warnings:[]};
 }});
 const adapter=createVertexAskSdkStepAdapter({...route,model});
 return {adapter,model,calls:()=>calls,actualInput:()=>actualInput,run:()=>adapter.runStep({...request,signal:new AbortController().signal})};
}

it.each(['emit','json','fence'] as const)('decodes all bounded construction handles through Vertex %s output',async channel=>{
 const fixture=controlledRun({claims:allowedClaims,abstained:false},channel);
 expect(fixture.adapter).toMatchObject({outputPolicy:'bounded_construction_v1'});
 const result=await fixture.run();
 expect(result).toMatchObject({acceptance:'accepted',usage:observedUsage,toolCalls:[],answer:{claims:[
  {construction:{mode:'source_quote',windowId,quote},citationWindowIds:[windowId]},
  {construction:{mode:'exact_count',toolCallId:'current-opportunities'},exactResultToolCallIds:['current-opportunities']},
  {construction:{mode:'opportunity_record',toolCallId:'current-opportunities',opportunityId},exactResultToolCallIds:['current-opportunities']},
 ]}});
 expect(fixture.calls()).toBe(1);
 // This adapter returns selections, not host-rendered or semantically verified prose.
 expect(result.answer).toMatchObject({claims:[{text:sourceClaim.text},{text:'Untrusted count prose'},{text:'Untrusted record prose'}]});
});

const refusedExamples=[
 {label:'missing construction',claims:[legacyClaim]},
 {label:'interpretation',claims:[interpretationClaim]},
 {label:'safe quote plus interpretation',claims:[sourceClaim,interpretationClaim]},
 {label:'safe quote plus legacy prose',claims:[sourceClaim,legacyClaim]},
];
for(const channel of ['emit','json','fence'] as const){
 it.each(refusedExamples)(`refuses whole Vertex ${channel} candidate with $label and conserves observed usage`,async example=>{
  const fixture=controlledRun({claims:example.claims,abstained:false},channel);
  expect(await fixture.run()).toEqual({acceptance:'accepted',usage:observedUsage,answer:null,toolCalls:[]});
  expect(fixture.calls()).toBe(1);
 });
}

it('serializes a required bounded construction union in the actual Vertex wire declaration',async()=>{
 const authClient=new OAuth2Client();authClient.setCredentials({access_token:'synthetic-token'});
 const requests:string[]=[];
 const model=createVertex({project:projectId,location:'us',googleAuthOptions:{authClient},fetch:async(_url,init)=>{
  requests.push(String(init?.body));
  return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{functionCall:{name:'emit_answer',args:{claims:[sourceClaim,interpretationClaim],abstained:false}}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:52,candidatesTokenCount:24,totalTokenCount:76}}),{headers:{'content-type':'application/json'}});
 }})('gemini-3.8-flash');
 const adapter=createVertexAskSdkStepAdapter({...route,model});
 const bound=adapter.inputBound!(request)!;
 expect(await adapter.runStep({...request,signal:new AbortController().signal})).toEqual({acceptance:'accepted',usage:observedUsage,answer:null,toolCalls:[]});
 expect(requests).toHaveLength(1);
 const wire=z.object({tools:z.array(z.object({functionDeclarations:z.array(z.object({name:z.string(),parameters:z.object({properties:z.object({claims:z.object({items:z.object({required:z.array(z.string()),properties:z.object({construction:z.unknown()}).passthrough()}).passthrough()}).passthrough()}).passthrough()}).passthrough()}).passthrough())}))}).parse(JSON.parse(requests[0]!));
 const emit=wire.tools.flatMap(tool=>tool.functionDeclarations).find(tool=>tool.name==='emit_answer')!;
 expect(emit.parameters.properties.claims.items.required).toContain('construction');
 const construction=JSON.stringify(emit.parameters.properties.claims.items.properties.construction);
 for(const mode of ['source_quote','exact_count','opportunity_record'])expect(construction).toContain(`"${mode}"`);
 expect(construction).not.toContain('"interpretation"');
 expect(construction).not.toContain('"oneOf"');
 expect(bound.inputBytes).toBeGreaterThanOrEqual(Buffer.byteLength(requests[0]!));
});

it('counts the compact bounded system and schema actually sent to the SDK before dispatch',async()=>{
 const vertex=controlledRun({claims:allowedClaims,abstained:false});
 const bound=vertex.adapter.inputBound!(request)!;
 expect(vertex.calls()).toBe(0);
 await vertex.run();
 expect(bound.inputBytes).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(vertex.actualInput())));
 expect(bound.maxInputTokens).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(vertex.actualInput())));
 const sdkInput=z.object({prompt:z.array(z.object({role:z.string(),content:z.unknown()}).passthrough()),tools:z.array(z.object({name:z.string(),inputSchema:z.unknown()}).passthrough())}).parse(vertex.actualInput());
 const system=sdkInput.prompt.find(message=>message.role==='system');
 const schema=JSON.stringify(sdkInput.tools.find(tool=>tool.name==='emit_answer')?.inputSchema);
 expect(schema).not.toContain('"interpretation"');
 let legacySystem:unknown;
 const model=new MockLanguageModelV3({doGenerate:async input=>{legacySystem=input.prompt.find(message=>message.role==='system');return {content:[{type:'tool-call',toolCallId:'final',toolName:'emit_answer',input:'{"claims":[],"abstained":true}'}],finishReason:{unified:'tool-calls',raw:'STOP'},usage,warnings:[]};}});
 const legacy=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model});
 await legacy.runStep({...request,signal:new AbortController().signal});
 expect(Buffer.byteLength(JSON.stringify(system))).toBeLessThan(Buffer.byteLength(JSON.stringify(legacySystem)));
 const larger=vertex.adapter.inputBound!({...request,transcript:[{windows:[{text:'😀'.repeat(1000)}]},...transcript]})!;
 expect(larger.inputBytes).toBeGreaterThan(bound.inputBytes);
});

it.each(['emit','json','fence'] as const)('preserves Bedrock legacy and interpretation compatibility for %s',async channel=>{
 const fixture=controlledRun({claims:[legacyClaim,interpretationClaim],abstained:false},channel);
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model:fixture.model});
 expect(await adapter.runStep({...request,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',usage:observedUsage,answer:{claims:[{text:legacyClaim.text,citationWindowIds:[windowId]},{construction:{mode:'interpretation',premises:'source'}}]},toolCalls:[]});
 expect(fixture.calls()).toBe(1);
});
