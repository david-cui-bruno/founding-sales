import {expect,it} from 'vitest';
import {z} from 'zod';
import {OAuth2Client} from 'google-auth-library';
import {createVertex} from '@ai-sdk/google-vertex';
import {askAgentTools,createVertexAskSdkStepAdapter} from '../src/providers/askAgentSdk.ts';

it('exposes the host browse page limit in the actual Vertex tool declaration',async()=>{
 const projectId='synthetic-project';
 const authClient=new OAuth2Client();authClient.setCredentials({access_token:'synthetic-token'});
 const requests:string[]=[];
 const model=createVertex({project:projectId,location:'us',googleAuthOptions:{authClient},fetch:async(_url,init)=>{
  requests.push(String(init?.body));
  return new Response(JSON.stringify({candidates:[{content:{role:'model',parts:[{functionCall:{name:'browse_history',args:{limit:10}}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,totalTokenCount:110}}),{headers:{'content-type':'application/json'}});
 }})('gemini-3.8-flash');
 const adapter=createVertexAskSdkStepAdapter({projectId,region:'us',endpointId:`vertex.us/${projectId}`,modelVersion:'gemini-3.8-flash',providerKey:'synthetic',model});
 const response=await adapter.runStep({question:'What is the latest plan?',transcript:[],remainingSteps:6,maxOutputTokens:4096,signal:new AbortController().signal});
 expect(requests).toHaveLength(1);
 const request=z.object({tools:z.array(z.object({functionDeclarations:z.array(z.object({name:z.string(),parameters:z.object({properties:z.object({limit:z.unknown().optional()}).passthrough()}).passthrough()}).passthrough())}))}).parse(JSON.parse(requests[0]!));
 const browse=request.tools.flatMap(entry=>entry.functionDeclarations).find(entry=>entry.name==='browse_history');
 expect(browse).toBeDefined();
 for(const [name,description] of [
  ['resolve_records','Integer from 1 through 20.'],
  ['search_history','Integer from 1 through 20.'],
  ['read_conversation','Integer from 1 through 10.'],
  ['search_selected','Integer from 1 through 20.'],
 ]){
  const declaration=request.tools.flatMap(entry=>entry.functionDeclarations).find(entry=>entry.name===name);
  expect(declaration?.parameters.properties.limit).toMatchObject({type:'integer',description});
 }
 expect(browse!.parameters.properties.limit).toMatchObject({type:'integer',description:'Integer from 1 through 5. For additional sources, use nextAfter as after on another page.'});
 expect(askAgentTools.browse_history.inputSchema.safeParse({limit:10}).success).toBe(false);
 expect(response).toMatchObject({acceptance:'accepted',usage:{inputTokens:100,outputTokens:10},answer:null,toolCalls:[{name:'browse_history',input:{limit:10}}]});
 // Transport metadata never widens or clamps the host-owned schema.
 for(const limit of [1,5])expect(askAgentTools.browse_history.inputSchema.safeParse({limit}).success).toBe(true);
 for(const limit of [0,6,10,1.5])expect(askAgentTools.browse_history.inputSchema.safeParse({limit}).success).toBe(false);
});
