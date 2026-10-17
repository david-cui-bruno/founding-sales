import {expect,it} from 'vitest';
import {boundedActualVertex} from './support/boundedActualVertex.ts';
import {syntheticPaidBudget} from './support/syntheticPaidBudget.ts';

it('reserves actual Vertex request before dispatch and preserves host signatures without observing them',async()=>{
 const snapshots:unknown[]=[];const observations:unknown[]=[];let calls=0;
 const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:value=>snapshots.push(value)});
 const {model}=boundedActualVertex(budget,{projectId:'colormyworld-prod-dc824',accessToken:'ephemeral-test-token',fetch:async(url,init)=>{
  calls++;expect(snapshots).toHaveLength(1);expect(String(url)).toBe('https://aiplatform.us.rep.googleapis.com/v1/projects/colormyworld-prod-dc824/locations/us/publishers/google/models/gemini-3.8-flash:generateContent');
  expect(new Headers(init?.headers).get('x-goog-user-project')).toBe('colormyworld-prod-dc824');
  return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'private reasoning',thought:true},{functionCall:{name:'read_exact',args:{operation:'tasks'}},thoughtSignature:'opaque-signature'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,thoughtsTokenCount:7,totalTokenCount:117}}),{headers:{'content-type':'application/json'}});
 }},value=>observations.push(value));
 const result=await model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'What tasks?'}]}],maxOutputTokens:4096,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}}});
 expect(calls).toBe(1);expect(result.usage.outputTokens.total).toBe(17);
 expect(result.content).toContainEqual(expect.objectContaining({type:'tool-call',providerMetadata:{vertex:{thoughtSignature:'opaque-signature'}}}));
 const observation=JSON.stringify(observations);expect(observation).toContain('read_exact');expect(observation).toContain('tasks');expect(observation).not.toContain('private reasoning');expect(observation).not.toContain('opaque-signature');expect(observation).not.toContain('ephemeral-test-token');
});

it('rejects excessive output, changed thinking and streaming before spending or transport',async()=>{
 let calls=0;const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async()=>{calls++;return new Response('{}');}});
 const input={prompt:[],maxOutputTokens:4097,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}}};
 await expect(model.doGenerate(input)).rejects.toThrow();
 await expect(model.doGenerate({...input,maxOutputTokens:32,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'high',includeThoughts:false}}}})).rejects.toThrow('synthetic_thinking_policy_mismatch');
 await expect(model.doStream()).rejects.toThrow('synthetic_streaming_forbidden');
 expect(calls).toBe(0);expect(budget.snapshot()).toEqual({startedSteps:0,allocatedCents:0});
});

it('conserves a dispatched uncertain call, never logs exception secrets and refuses additional generations',async()=>{
 const observations:unknown[]=[];let calls=0;const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async()=>{calls++;throw new Error('secret authorization: token');}},value=>observations.push(value));
 const input={prompt:[],maxOutputTokens:32,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}}};
 await expect(model.doGenerate(input)).rejects.toThrow('synthetic_vertex_call_unknown');
 expect(budget.snapshot().startedSteps).toBe(1);expect(budget.snapshot().allocatedCents).toBeGreaterThan(0);
 expect(JSON.stringify(observations)).not.toContain('secret');
 await expect(model.doGenerate(input)).rejects.toThrow('synthetic_vertex_batch_stopped');expect(calls).toBe(1);
});

it('holds unknown billing when candidate plus thought tokens exceed the requested ceiling',async()=>{
 const observations:unknown[]=[];const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async()=>new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'[]'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,thoughtsTokenCount:30,totalTokenCount:140}}),{headers:{'content-type':'application/json'}})},value=>observations.push(value));
 await expect(model.doGenerate({prompt:[],maxOutputTokens:32,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}}})).rejects.toThrow('synthetic_vertex_call_unknown');
 expect(budget.snapshot().startedSteps).toBe(1);expect(observations).toEqual([{channel:'ask',phase:'failed',step:1,httpStatus:200,errorCategory:'unknown_transport'}]);
});

it('uses the same bounded transport and conserved budget for its single-generation probe',async()=>{
 const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});let calls=0;
 const wrapped=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async(_url,init)=>{
  calls++;const request=JSON.parse(String(init?.body));expect(request.generationConfig).toMatchObject({maxOutputTokens:256,thinkingConfig:{thinkingLevel:'low',includeThoughts:false}});
  return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'[]'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:2,totalTokenCount:102}}),{headers:{'content-type':'application/json'}});
 }});
 expect(await wrapped.probe(new AbortController().signal)).toEqual({usage:{inputTokens:100,outputTokens:2},text:'[]'});expect(calls).toBe(1);expect(budget.snapshot().startedSteps).toBe(1);
});

it('refuses hidden thinking-budget overrides before dispatch',async()=>{
 const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});let calls=0;
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async()=>{calls++;return new Response('{}');}});
 await expect(model.doGenerate({prompt:[],maxOutputTokens:32,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false,thinkingBudget:4000}}}})).rejects.toThrow('synthetic_thinking_policy_mismatch');
 expect(calls).toBe(0);expect(budget.snapshot().startedSteps).toBe(0);
});

it('rejects oversized serialized requests and prevents dispatch when persistence fails',async()=>{
 let calls=0;const transport=async()=>{calls++;return new Response('{}');};
 const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{throw new Error('ledger failed');}});
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:transport});
 const policy={vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}};
 await expect(model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'x'.repeat(30000)}]}],maxOutputTokens:32,providerOptions:policy})).rejects.toThrow('synthetic_vertex_call_unknown');
 expect(budget.snapshot().startedSteps).toBe(0);
 await expect(model.doGenerate({prompt:[],maxOutputTokens:32,providerOptions:policy})).rejects.toThrow('synthetic_vertex_call_unknown');
 expect(calls).toBe(0);expect(budget.snapshot().startedSteps).toBe(1);
});

it('holds an input usage report that exceeds the reserved serialized request bound',async()=>{
 const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async()=>new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'[]'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:50000,candidatesTokenCount:2,totalTokenCount:50002}}),{headers:{'content-type':'application/json'}})});
 await expect(model.doGenerate({prompt:[],maxOutputTokens:32,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}}})).rejects.toThrow('synthetic_vertex_call_unknown');
 expect(budget.snapshot().startedSteps).toBe(1);
});

it('holds negative reasoning counts even if the combined output total looks valid',async()=>{
 const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async()=>new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'[]'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,thoughtsTokenCount:-5,totalTokenCount:105}}),{headers:{'content-type':'application/json'}})});
 await expect(model.doGenerate({prompt:[],maxOutputTokens:32,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}}})).rejects.toThrow('synthetic_vertex_call_unknown');
 expect(budget.snapshot().startedSteps).toBe(1);
});

it('refuses provider-native tools outside the approved host-only tool loop before spending',async()=>{
 const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});let calls=0;
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async()=>{calls++;return new Response('{}');}});
 await expect(model.doGenerate({prompt:[],maxOutputTokens:32,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}},tools:[{type:'provider',id:'google.google_search',name:'google_search',args:{}}]})).rejects.toThrow();
 expect(calls).toBe(0);expect(budget.snapshot().startedSteps).toBe(0);
});

it('records only numeric authentication status and conserves the rejected allocation',async()=>{
 const observations:unknown[]=[];const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});let calls=0;
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async()=>{calls++;return new Response('private provider error body',{status:403});}},value=>observations.push(value));
 await expect(model.doGenerate({prompt:[],maxOutputTokens:32,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}}})).rejects.toThrow('synthetic_vertex_call_unknown');
 expect(calls).toBe(1);expect(budget.snapshot().startedSteps).toBe(1);expect(observations).toEqual([{channel:'ask',phase:'failed',step:1,httpStatus:403,errorCategory:'authentication'}]);
});

it('refuses image input because the serialized text allowance cannot price image tokens',async()=>{
 let calls=0;const budget=syntheticPaidBudget({maxSteps:5,maxCents:500,persist:()=>{}});
 const {model}=boundedActualVertex(budget,{projectId:'synthetic-project',accessToken:'token',fetch:async()=>{calls++;return new Response('{}');}});
 await expect(model.doGenerate({prompt:[{role:'user',content:[{type:'file',data:new URL('https://example.com/image.png'),mediaType:'image/png'}]}],maxOutputTokens:32,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}}})).rejects.toThrow();
 expect(calls).toBe(0);expect(budget.snapshot().startedSteps).toBe(0);
});
