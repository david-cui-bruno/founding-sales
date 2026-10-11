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
