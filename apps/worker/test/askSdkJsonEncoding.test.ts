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

it('refuses the observed nested-string claims envelope without inventing citations or losing known usage',async()=>{
 const captured="{\"claims\":\"[{\\\"text\\\":\\\"Example Sales has two current open pilot opportunities: 'North pilot' and 'South pilot', both at the 'new' stage.\\\",\\\"kind\\\":\\\"fact\\\",\\\"citationWindowIds\\\":[\\\"c9be7eab-f92c-4b60-8784-fdc8dd98a99c\\\"]},{\\\"text\\\":\\\"An email states 'The pilot needs a revised proposal,' but does not name which pilot opportunity requires it \u2014 leaving it ambiguous whether the North pilot or South pilot is the one referred to.\\\",\\\"kind\\\":\\\"fact\\\",\\\"citationWindowIds\\\":[\\\"c9be7eab-f92c-4b60-8784-fdc8dd98a99c\\\"]},{\\\"text\\\":\\\"It cannot be determined from available evidence whether the revised proposal is needed for the North pilot, the South pilot, or both; the ambiguity cannot be resolved and should be preserved.\\\",\\\"kind\\\":\\\"inference\\\",\\\"citationWindowIds\\\":[\\\"c9be7eab-f92c-4b60-8784-fdc8dd98a99c\\\"]}],\\\"abstained\\\":false}\"}";
 expect(await run(captured)).toMatchObject({acceptance:'accepted',answer:null,usage:{inputTokens:52,outputTokens:24}});
});
it('gives explicit array, exact-state and unverified-date instructions to the SDK model',async()=>{
 let prompt='';
 const model=new MockLanguageModelV3({doGenerate:async input=>{prompt=JSON.stringify(input.prompt);return {content:[{type:'text',text:'{"claims":[],"abstained":true}'}],finishReason:{unified:'stop',raw:'end_turn'},usage:{inputTokens:{total:52,noCache:52,cacheRead:0,cacheWrite:0},outputTokens:{total:24,text:24,reasoning:0}},warnings:[]};}});
 await createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'controlled',providerKey:'controlled',model}).runStep({question:'Which proposal is current?',transcript:[],maxOutputTokens:64,remainingSteps:1,signal:new AbortController().signal});
 expect(prompt).toContain('claims must be a JSON array, never a JSON-encoded string');
 expect(prompt).toContain('Do not cite a conversation window for counts, stages or opportunity names established only by read_exact');
 expect(prompt).toContain('occurredAt is a source event date; observedAt is capture/import time');
 expect(prompt).toContain('User-supplied dates do not establish authorship');
 expect(prompt).toContain('Prefer one to three complete, directly responsive sentences');
 expect(prompt).toContain('Do not repeat internal authority codes');
 expect(prompt).toContain('Preserve uncertainty when it changes the answer');
});
