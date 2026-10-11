import {expect,it} from 'vitest';
import {MockLanguageModelV3} from 'ai/test';
import {createAskSdkStepAdapter} from '../src/providers/askAgentSdk.ts';
// Exact synthetic diagnostic response captured before this expectation was written.
const captured='```json\n{\n  "claims": [],\n  "abstained": true\n}\n```';
it('normalizes only a complete single JSON fence through the ordinary SDK adapter',async()=>{
 for(const text of [captured,'{"claims":[],"abstained":true}','```\n{"claims":[],"abstained":true}\n```']){
  const result=await run(text);expect(result).toMatchObject({acceptance:'accepted',answer:{claims:[],abstained:true},usage:{inputTokens:52,outputTokens:24}});
 }
 for(const text of ['Analysis: '+captured,captured+' trailing',captured+'\n'+captured,'[] []','```json\n{broken}\n```'])expect(await run(text)).toMatchObject({acceptance:'accepted',answer:null,usage:{inputTokens:52,outputTokens:24}});
});
function run(text:string){
 const model=new MockLanguageModelV3({doGenerate:async()=>({content:[{type:'text',text}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:52,noCache:52,cacheRead:0,cacheWrite:0},outputTokens:{total:24,text:24,reasoning:0}},warnings:[]})});
 return createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model}).runStep({question:'Synthetic?',transcript:[],maxOutputTokens:64,signal:new AbortController().signal});
}
