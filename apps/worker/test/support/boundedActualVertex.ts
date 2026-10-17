import {createVertex, type GoogleVertexProviderSettings} from '@ai-sdk/google-vertex';
import {generateText,stepCountIs} from 'ai';
import {OAuth2Client} from 'google-auth-library';
import type {syntheticPaidBudget} from './syntheticPaidBudget.ts';

type Observation={channel:'ask'|'extraction_or_probe';phase:'returned'|'failed';step:number;httpStatus?:number;output?:unknown;usage?:unknown;stopReason?:unknown;errorCategory?:'authentication'|'invalid_sdk_response'|'unknown_transport'};
type Settings={projectId:string;accessToken:string;fetch?:GoogleVertexProviderSettings['fetch']};
/** Isolated synthetic transport only. Credentials stay in memory; the original
 * SDK result (including opaque tool metadata) returns only to the host. */
export function boundedActualVertex(budget:ReturnType<typeof syntheticPaidBudget>,settings:Settings,observe?:(value:Observation)=>void){
 if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(settings.projectId)||!settings.accessToken)throw new Error('synthetic_vertex_configuration_invalid');
 const authClient=new OAuth2Client();authClient.setCredentials({access_token:settings.accessToken});
 const baseURL=`https://aiplatform.us.rep.googleapis.com/v1/projects/${settings.projectId}/locations/us/publishers/google`;
 let stopped=false;let inputBound=0;let httpStatus:number|undefined;
 const transport=settings.fetch??globalThis.fetch;
 const actual=createVertex({project:settings.projectId,location:'us',baseURL,headers:{'x-goog-user-project':settings.projectId},googleAuthOptions:{authClient},fetch:async(url,init)=>{
  if(String(url)!==`${baseURL}/models/gemini-3.8-flash:generateContent`||init?.method!=='POST'||new Headers(init.headers).get('x-goog-user-project')!==settings.projectId)throw new Error('synthetic_model_route_changed');
  if(typeof init.body!=='string')throw new Error('synthetic_request_bound_exceeded');
  const body=JSON.parse(init.body) as {generationConfig?:{maxOutputTokens?:number;thinkingConfig?:{thinkingLevel?:unknown;includeThoughts?:unknown}}};
  const generation=body.generationConfig;
  if(generation?.thinkingConfig?.thinkingLevel!=='low'||generation.thinkingConfig.includeThoughts!==false)throw new Error('synthetic_thinking_policy_mismatch');
  if(Buffer.byteLength(init.body,'utf8')+2048>30000)throw new Error('synthetic_request_bound_exceeded');
  inputBound=Buffer.byteLength(init.body,'utf8')+2048;
  return budget.run(body,generation.maxOutputTokens??0,async()=>{const response=await transport(url,{...init,redirect:'error'});httpStatus=response.status;return response;});
 }} )('gemini-3.8-flash');
 const model={specificationVersion:actual.specificationVersion,provider:actual.provider,modelId:actual.modelId,supportedUrls:actual.supportedUrls,
  async doGenerate(input:Parameters<typeof actual.doGenerate>[0]){
   if(stopped)throw new Error('synthetic_vertex_batch_stopped');
   if(input.prompt.some(message=>message.role==='user'&&message.content.some(part=>part.type!=='text')))throw new Error('synthetic_modality_forbidden');
   if(input.tools?.some(tool=>tool.type!=='function'))throw new Error('synthetic_native_tools_forbidden');
   const policy=input.providerOptions?.['vertex']?.['thinkingConfig'];
   if(typeof policy!=='object'||policy===null||Array.isArray(policy)||policy['thinkingLevel']!=='low'||policy['includeThoughts']!==false||Object.keys(policy).some(key=>!['thinkingLevel','includeThoughts'].includes(key)))throw new Error('synthetic_thinking_policy_mismatch');
   if(!Number.isInteger(input.maxOutputTokens)||input.maxOutputTokens!<1||input.maxOutputTokens!>4096)throw new Error('synthetic_request_bound_exceeded');
   httpStatus=undefined;
   const before=budget.snapshot().startedSteps;
   try{
    const result=await actual.doGenerate(input);
    const usage=result.usage;
    const counts=[usage.inputTokens.noCache,usage.inputTokens.cacheRead,usage.inputTokens.cacheWrite,usage.outputTokens.text,usage.outputTokens.reasoning];
    if(counts.some(value=>value!==undefined&&(!Number.isSafeInteger(value)||value<0)))throw new Error('synthetic_usage_uncertain');
    if(!Number.isSafeInteger(usage.inputTokens.total)||usage.inputTokens.total!<0||usage.inputTokens.total!>inputBound||!Number.isSafeInteger(usage.outputTokens.total)||usage.outputTokens.total!<0||usage.outputTokens.total!>(input.maxOutputTokens??0)||(usage.inputTokens.cacheWrite??0)>0)throw new Error('synthetic_usage_uncertain');
    const output=result.content.flatMap<unknown>(part=>part.type==='text'?[{type:'text',text:part.text}]:part.type==='tool-call'?[{type:'tool-call',toolCallId:part.toolCallId,toolName:part.toolName,input:part.input}]:[]);
    observe?.({channel:'ask',phase:'returned',step:budget.snapshot().startedSteps,output,usage:{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens},stopReason:result.finishReason});
    return result;
   }catch{
    stopped=budget.snapshot().startedSteps>before;
    observe?.({channel:'ask',phase:'failed',step:budget.snapshot().startedSteps,...(httpStatus===undefined?{}:{httpStatus}),errorCategory:httpStatus===401||httpStatus===403?'authentication':'unknown_transport'});
    throw new Error('synthetic_vertex_call_unknown');
   }
  },async doStream(){throw new Error('synthetic_streaming_forbidden');}};
 return {model,async probe(signal:AbortSignal){
  const result=await generateText({model,maxRetries:0,stopWhen:stepCountIs(1),abortSignal:signal,maxOutputTokens:256,providerOptions:{vertex:{thinkingConfig:{thinkingLevel:'low',includeThoughts:false}}},prompt:'Synthetic diagnostic transport probe. Return JSON only: []. No tools.'});
  if(!Number.isSafeInteger(result.usage.inputTokens)||!Number.isSafeInteger(result.usage.outputTokens))throw new Error('synthetic_vertex_call_unknown');
  return {usage:{inputTokens:result.usage.inputTokens!,outputTokens:result.usage.outputTokens!},text:result.text};
 }};
}
