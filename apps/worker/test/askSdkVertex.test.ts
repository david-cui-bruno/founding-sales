import {expect,it} from 'vitest';
import {MockLanguageModelV3} from 'ai/test';
import {OAuth2Client} from 'google-auth-library';
import {createVertex} from '@ai-sdk/google-vertex';
import {createVertexAskSdkStepAdapter} from '../src/providers/askAgentSdk.ts';

const projectId='synthetic-project';
const endpointId=`vertex.us/${projectId}`;
const baseURL=`https://aiplatform.us.rep.googleapis.com/v1/projects/${projectId}/locations/us/publishers/google`;
it('round-trips each Gemini readonly call signature into the next host-executed step without SDK execution',async()=>{
 const authClient=new OAuth2Client();authClient.setCredentials({access_token:'synthetic-token'});
 const requests:{url:string;body:Record<string,unknown>}[]=[];
 const model=createVertex({project:projectId,location:'us',baseURL,googleAuthOptions:{authClient},fetch:async(url,init)=>{
  requests.push({url:String(url),body:JSON.parse(String(init?.body))});
  const parts=requests.length===1?[
   {functionCall:{id:'read-1',name:'read_exact',args:{operation:'tasks'}},thoughtSignature:'opaque-one'},
   {functionCall:{id:'read-2',name:'browse_history',args:{limit:2}},thoughtSignature:'opaque-two'},
  ]:[{functionCall:{id:'final',name:'emit_answer',args:{claims:[],abstained:true}}}];
  return new Response(JSON.stringify({candidates:[{content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,thoughtsTokenCount:7,totalTokenCount:117}}),{headers:{'content-type':'application/json'}});
 }})('gemini-3.8-flash');
 const adapter=createVertexAskSdkStepAdapter({projectId,region:'us',endpointId,modelVersion:'gemini-3.8-flash',providerKey:'synthetic',model});
 const request={question:'What needs attention?',transcript:[],maxOutputTokens:4096,remainingSteps:2,signal:new AbortController().signal};
 const first=await adapter.runStep(request);
 expect(first).toMatchObject({acceptance:'accepted',usage:{inputTokens:100,outputTokens:17},answer:null,toolCalls:[{id:'read-1',providerMetadata:{vertex:{thoughtSignature:'opaque-one'}}},{id:'read-2',providerMetadata:{vertex:{thoughtSignature:'opaque-two'}}}]});
 expect(requests).toHaveLength(1);
 const transcript=first.toolCalls.map(call=>({modelStep:1,toolCallId:call.id,name:call.name,input:call.input,providerMetadata:call.providerMetadata,result:{records:[]}}));
 const secondRequest={...request,transcript,remainingSteps:1};
 const second=await adapter.runStep(secondRequest);
 expect(second).toMatchObject({acceptance:'accepted',usage:{inputTokens:100,outputTokens:17},answer:{claims:[],abstained:true},toolCalls:[]});
 expect(requests).toHaveLength(2);
 expect(requests[0]!.url).toBe(`${baseURL}/models/gemini-3.8-flash:generateContent`);
 expect(requests[0]!.body['generationConfig']).toMatchObject({maxOutputTokens:4096,thinkingConfig:{thinkingLevel:'low',includeThoughts:false}});
 expect(requests[1]!.body['contents']).toMatchObject([{role:'user'},{role:'model',parts:[{functionCall:{name:'read_exact'}},{functionCall:{name:'browse_history'}}]},{role:'user',parts:[{functionResponse:{name:'read_exact'}},{functionResponse:{name:'browse_history'}}]}]);
 const replay=JSON.stringify(requests[1]!.body);expect(replay).toContain('opaque-one');expect(replay).toContain('opaque-two');expect(replay).not.toContain('skip_thought_signature_validator');
 expect(adapter.inputBound!(secondRequest)!.inputBytes).toBeGreaterThanOrEqual(Buffer.byteLength(replay));
});

it('rejects mismatched Vertex authority routes before constructing a provider',()=>{
 for(const invalid of [
  {projectId:'other-project',endpointId},
  {projectId,endpointId:'vertex.eu/synthetic-project'},
  {projectId:'../escape',endpointId:'vertex.us/../escape'},
 ])expect(()=>createVertexAskSdkStepAdapter({region:'us',modelVersion:'gemini-3.8-flash',providerKey:'synthetic',...invalid})).toThrow('ask_agent_endpoint_mismatch');
});
it('never retries an ambiguous Vertex failure or sends after cancellation',async()=>{
 const authClient=new OAuth2Client();authClient.setCredentials({access_token:'synthetic-token'});let calls=0;
 const model=createVertex({project:projectId,location:'us',baseURL,googleAuthOptions:{authClient},fetch:async()=>{calls++;return new Response('{"error":{"message":"temporary provider error"}}',{status:503,headers:{'content-type':'application/json'}});}})('gemini-3.8-flash');
 const adapter=createVertexAskSdkStepAdapter({projectId,region:'us',endpointId,modelVersion:'gemini-3.8-flash',providerKey:'synthetic',model});
 const request={question:'What changed?',transcript:[],maxOutputTokens:4096,remainingSteps:1};
 expect(await adapter.runStep({...request,signal:new AbortController().signal})).toEqual({acceptance:'unknown',usage:null,answer:null,toolCalls:[]});expect(calls).toBe(1);
 const abort=new AbortController();abort.abort();
 expect(await adapter.runStep({...request,signal:abort.signal})).toEqual({acceptance:'not_accepted',usage:{inputTokens:0,outputTokens:0},answer:null,toolCalls:[]});expect(calls).toBe(1);
});

it('settles known usage but does not replay or execute oversized opaque provider state',async()=>{
 const model=new MockLanguageModelV3({doGenerate:async()=>({content:[{type:'tool-call',toolCallId:'read',toolName:'read_exact',input:'{"operation":"tasks"}',providerMetadata:{vertex:{thoughtSignature:'x'.repeat(65536)}}}],finishReason:{unified:'tool-calls',raw:'STOP'},usage:{inputTokens:{total:100,noCache:100,cacheRead:0,cacheWrite:0},outputTokens:{total:17,text:10,reasoning:7}},warnings:[]})});
 const adapter=createVertexAskSdkStepAdapter({projectId,region:'us',endpointId,modelVersion:'gemini-3.8-flash',providerKey:'synthetic',model});
 expect(await adapter.runStep({question:'Tasks?',transcript:[],maxOutputTokens:4096,signal:new AbortController().signal})).toEqual({acceptance:'accepted',usage:{inputTokens:100,outputTokens:17},answer:null,toolCalls:[]});
});
it('keeps different host generations separate when replaying Gemini signatures',async()=>{
 const authClient=new OAuth2Client();authClient.setCredentials({access_token:'synthetic-token'});let sent:Record<string,unknown>={};
 const model=createVertex({project:projectId,location:'us',baseURL,googleAuthOptions:{authClient},fetch:async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{functionCall:{name:'emit_answer',args:{claims:[],abstained:true}}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,totalTokenCount:110}}),{headers:{'content-type':'application/json'}});}})('gemini-3.8-flash');
 const adapter=createVertexAskSdkStepAdapter({projectId,region:'us',endpointId,modelVersion:'gemini-3.8-flash',providerKey:'synthetic',model});
 const transcript=[1,2].map(modelStep=>({modelStep,toolCallId:`read-${modelStep}`,name:'read_exact',input:{operation:'tasks'},result:{count:0},providerMetadata:{vertex:{thoughtSignature:`signature-${modelStep}`}}}));
 expect(await adapter.runStep({question:'Tasks?',transcript,maxOutputTokens:4096,remainingSteps:1,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',answer:{claims:[],abstained:true}});
 expect(sent['contents']).toMatchObject([{role:'user'},{role:'model',parts:[{thoughtSignature:'signature-1'}]},{role:'user'},{role:'model',parts:[{thoughtSignature:'signature-2'}]},{role:'user'}]);
});
