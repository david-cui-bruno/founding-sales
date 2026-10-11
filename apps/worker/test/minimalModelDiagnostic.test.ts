import {expect,it} from 'vitest';
import {MockLanguageModelV3} from 'ai/test';
import {runMinimalModelDiagnostic} from './support/minimalModelDiagnostic.ts';
it('uses only two bounded native generations, no tools, and preserves actual extraction encoding observations',async()=>{
 let calls=0;
 const model=new MockLanguageModelV3({doGenerate:async input=>{calls++;expect(input.maxOutputTokens).toBe(64);expect(input.tools??[]).toEqual([]);return {content:[{type:'text',text:'{"claims":[],"abstained":true}'}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:5,text:5,reasoning:0}},warnings:[]};}});
 const result=await runMinimalModelDiagnostic({modelVersion:'controlled',model,sourceText:'Send proposal.',surface:{converse:async request=>{calls++;expect(request.inferenceConfig.maxTokens).toBe(1024);return {stopReason:'end_turn',usage:{inputTokens:11,outputTokens:6},output:{message:{role:'assistant',content:[{text:'```json\n[]\n```'}]}}};}}});
 expect(calls).toBe(2);expect(result).toMatchObject({phase:'completed_native_transport_observations',ask:{usage:{inputTokens:10,outputTokens:5}},extraction:{acceptance:'accepted',claims:[]},businessQualityAccepted:false});
});
it('stops on the first unknown generation without a second attempt or retry',async()=>{
 let calls=0;
 const model=new MockLanguageModelV3({doGenerate:async()=>{calls++;throw new Error('unknown transport fixture');}});
 const result=await runMinimalModelDiagnostic({modelVersion:'controlled',model,sourceText:'Send proposal.',surface:{converse:async()=>{throw new Error('second attempt forbidden');}}});
 expect(calls).toBe(1);expect(result).toMatchObject({phase:'stopped_unknown_ask',extraction:null,businessQualityAccepted:false});
});
it('retains billed malformed extraction as an observation without treating transport completion as business acceptance',async()=>{
 const model=new MockLanguageModelV3({doGenerate:async()=>({content:[{type:'text',text:'{"claims":[],"abstained":true}'}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:5,text:5,reasoning:0}},warnings:[]})});
 const result=await runMinimalModelDiagnostic({modelVersion:'controlled',model,sourceText:'Send proposal.',surface:{converse:async()=>({stopReason:'end_turn',usage:{inputTokens:11,outputTokens:6},output:{message:{role:'assistant',content:[{text:'Here is my analysis: []'}]}}})}});
 expect(result).toMatchObject({phase:'completed_native_transport_observations',extraction:{acceptance:'accepted',usage:{inputTokens:11,outputTokens:6},claims:null},businessQualityAccepted:false});
});
