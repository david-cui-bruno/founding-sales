import {BedrockRuntimeClient,InvokeModelCommand} from '@aws-sdk/client-bedrock-runtime';
import {z} from 'zod';
import {BEDROCK_REFUSED_EXCEPTIONS} from '@fss/domain/classification/bedrockClient.ts';
import type {AskEmbeddingAdapter} from '@fss/domain/crm/askAnswerPorts.ts';
const body=z.object({embedding:z.array(z.number().finite()).min(256).max(1024),inputTextTokenCount:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
const refusal=z.object({name:z.string(),$metadata:z.object({httpStatusCode:z.number().int()})});
/** Actual Titan InvokeModel conversion. No inner retry, grant or pricing fallback. */
export function createAskTitanAdapter(input:{region:'us-east-1';endpointId:string;providerKey:string;dimensions:256|512|1024;invoke?:(body:string,signal:AbortSignal)=>Promise<unknown>}):AskEmbeddingAdapter{
 if(input.endpointId!==`bedrock-runtime.${input.region}.amazonaws.com`)throw new Error('ask_embedding_endpoint_mismatch');
 const client=input.invoke?null:new BedrockRuntimeClient({region:input.region,maxAttempts:1,requestHandler:{requestTimeout:30000,connectionTimeout:5000}});
 const invoke=input.invoke??((text:string,signal:AbortSignal)=>client!.send(new InvokeModelCommand({modelId:'amazon.titan-embed-text-v2:0',contentType:'application/json',accept:'application/json',body:text}),{abortSignal:signal}));
 const adapter:AskEmbeddingAdapter={endpointId:input.endpointId,providerKey:input.providerKey,modelVersion:'amazon.titan-embed-text-v2:0',dimensions:input.dimensions,async embed(request){
  if(request.signal.aborted||Buffer.byteLength(request.text)>40000||!request.text.length)return {acceptance:'not_accepted',usage:{inputTokens:0,outputTokens:0},vector:null};
  try{const raw=z.object({body:z.instanceof(Uint8Array)}).safeParse(await invoke(JSON.stringify({inputText:request.text,dimensions:input.dimensions,normalize:true}),request.signal));if(!raw.success||raw.data.body.byteLength>100000)return {acceptance:'unknown',usage:null,vector:null};const value:unknown=JSON.parse(Buffer.from(raw.data.body).toString('utf8'));const parsed=body.safeParse(value);if(!parsed.success){const known=z.object({inputTextTokenCount:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).safeParse(value);return known.success?{acceptance:'accepted',usage:{inputTokens:known.data.inputTextTokenCount,outputTokens:0},vector:null}:{acceptance:'unknown',usage:null,vector:null};}return {acceptance:'accepted',usage:{inputTokens:parsed.data.inputTextTokenCount,outputTokens:0},vector:parsed.data.embedding.length===input.dimensions?parsed.data.embedding:null};}catch(error){const parsed=refusal.safeParse(error);if(parsed.success&&parsed.data.$metadata.httpStatusCode>=400&&parsed.data.$metadata.httpStatusCode<500&&BEDROCK_REFUSED_EXCEPTIONS.has(parsed.data.name))return {acceptance:'not_accepted',usage:{inputTokens:0,outputTokens:0},vector:null};return {acceptance:'unknown',usage:null,vector:null};}
 }};return Object.freeze(adapter);
}
