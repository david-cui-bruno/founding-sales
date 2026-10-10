import {z} from 'zod';
import {BEDROCK_REFUSED_EXCEPTIONS} from '@fss/domain/classification/bedrockClient.ts';
import type {PilotPorts} from './realPilot.ts';
const MODEL='amazon.titan-embed-text-v2:0';
export interface TitanSurface {kind:'controlled'|'real';invoke(input:{modelId:string;contentType:'application/json';accept:'application/json';body:string},signal:AbortSignal):Promise<unknown>}
const response=z.object({body:z.instanceof(Uint8Array)});
const embedded=z.object({embedding:z.array(z.number().finite()).min(1).max(1024),inputTextTokenCount:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
const failure=z.object({name:z.string(),$metadata:z.object({httpStatusCode:z.number().int()})});
/** Caller reserves and revalidates before dispatch. Transport has no retry/grant authority. */
export function createTitanPilotTransport(surface:TitanSurface,dimensions:256|512|1024=1024):PilotPorts['embedding'] {
 return {kind:surface.kind,modelId:MODEL,dimensions,async run(text,signal){
  if(signal.aborted||text.length===0||Buffer.byteLength(text)>40000)return {acceptance:'not_accepted',usage:{inputTokens:0,outputTokens:0},vector:null};
  let raw:unknown;try{raw=await surface.invoke({modelId:MODEL,contentType:'application/json',accept:'application/json',body:JSON.stringify({inputText:text,dimensions,normalize:true})},signal);}catch(error){const refused=failure.safeParse(error);if(refused.success&&refused.data.$metadata.httpStatusCode>=400&&BEDROCK_REFUSED_EXCEPTIONS.has(refused.data.name))return {acceptance:'not_accepted',usage:{inputTokens:0,outputTokens:0},vector:null};return {acceptance:'unknown',usage:null,vector:null};}
  const body=response.safeParse(raw);if(!body.success||body.data.body.byteLength>100000)return {acceptance:'unknown',usage:null,vector:null};
  let value:unknown;try{value=JSON.parse(Buffer.from(body.data.body).toString('utf8')) as unknown;}catch{return {acceptance:'unknown',usage:null,vector:null};}
  const parsed=embedded.safeParse(value);if(!parsed.success){const usage=z.object({inputTextTokenCount:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).safeParse(value);return usage.success?{acceptance:'accepted',usage:{inputTokens:usage.data.inputTextTokenCount,outputTokens:0},vector:null}:{acceptance:'unknown',usage:null,vector:null};}
  return {acceptance:'accepted',usage:{inputTokens:parsed.data.inputTextTokenCount,outputTokens:0},vector:parsed.data.embedding.length===dimensions?parsed.data.embedding:null};
 }};
}
interface Sdk {BedrockRuntimeClient:new(options:{region:string;maxAttempts:1;requestHandler:{requestTimeout:number;connectionTimeout:number}})=>{send(command:unknown,options:{abortSignal:AbortSignal}):Promise<unknown>};InvokeModelCommand:new(input:Parameters<TitanSurface['invoke']>[0])=>unknown}
/** Explicit opt-in SDK load; uses caller's authorized runtime, never desktop credentials. */
export async function loadTitanPilotSurface(region:'us-east-1'):Promise<TitanSurface>{const moduleName='@aws-sdk/client-bedrock-runtime';const sdk=await import(moduleName) as Sdk;const client=new sdk.BedrockRuntimeClient({region,maxAttempts:1,requestHandler:{requestTimeout:30000,connectionTimeout:5000}});return {kind:'real',invoke:async(input,signal)=>client.send(new sdk.InvokeModelCommand(input),{abortSignal:signal})};}
