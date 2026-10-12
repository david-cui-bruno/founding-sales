import {createBedrockAskSdkModel} from '../../src/providers/askAgentSdk.ts';
import {loadCrmBedrockSurface} from '../../src/providers/crmBedrock.ts';
import type {syntheticPaidBudget} from './syntheticPaidBudget.ts';
type Observation={channel:'ask'|'extraction_or_probe';phase:'returned'|'failed';step:number;output?:unknown;usage?:unknown;stopReason?:unknown;errorCategory?:'credentials'|'authentication'|'invalid_sdk_response'|'unknown_transport'};
function category(error:unknown):NonNullable<Observation['errorCategory']>{
 const text=error instanceof Error?`${error.name} ${error.message}`:'';
 if(/credential|AWS_ACCESS_KEY|AWS_SECRET_ACCESS/iu.test(text))return 'credentials';
 if(/AccessDenied|Unauthorized|Signature/iu.test(text))return 'authentication';
 if(/TypeValidation|InvalidResponse|JSONParse/iu.test(text))return 'invalid_sdk_response';
 return 'unknown_transport';
}
/** Actual SDK transport, wrapped only for aggregate limits and explicitly private
 * synthetic response observations. Never copy request headers or raw exceptions. */
export async function boundedActualBedrock(budget:ReturnType<typeof syntheticPaidBudget>,modelVersion:string,observe?:(value:Observation)=>void,policy?:{thinking:'disabled'},transports?:{model:ReturnType<typeof createBedrockAskSdkModel>;surface:Awaited<ReturnType<typeof loadCrmBedrockSurface>>}){
 const checkThinking=(input:unknown,channel:'ask'|'native')=>{if(!policy)return;const request=input as {providerOptions?:{bedrock?:{additionalModelRequestFields?:{thinking?:{type?:unknown}};reasoningConfig?:{type?:unknown;budgetTokens?:unknown}}};additionalModelRequestFields?:{thinking?:{type?:unknown}}};const type=channel==='ask'?request.providerOptions?.bedrock?.additionalModelRequestFields?.thinking?.type:request.additionalModelRequestFields?.thinking?.type;const reasoning=request.providerOptions?.bedrock?.reasoningConfig;if(type!=='disabled'||channel==='ask'&&reasoning&&(reasoning.type!==undefined&&reasoning.type!=='disabled'||reasoning.budgetTokens!==undefined))throw new Error('synthetic_thinking_policy_mismatch');};
 const actual=transports?.model??createBedrockAskSdkModel({region:'us-east-1',modelVersion});
 const model={specificationVersion:actual.specificationVersion,provider:actual.provider,modelId:actual.modelId,supportedUrls:actual.supportedUrls,
  doGenerate:(input:Parameters<typeof actual.doGenerate>[0])=>{checkThinking(input,'ask');return budget.run(input,input.maxOutputTokens??1000,async()=>{
   const step=budget.snapshot().startedSteps;
   try{const result=await actual.doGenerate(input);observe?.({channel:'ask',phase:'returned',step,output:result.content,usage:result.usage});return result;}
   catch(error){observe?.({channel:'ask',phase:'failed',step,errorCategory:category(error)});throw error;}
  });},doStream:async()=>{throw new Error('synthetic_streaming_forbidden');}};
 const surface=transports?.surface??await loadCrmBedrockSurface({region:'us-east-1',timeoutMilliseconds:30000});
 const boundedSurface={endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:(input:Parameters<typeof surface.converse>[0],signal:AbortSignal)=>{if(input.modelId!==modelVersion)throw new Error('synthetic_model_route_changed');checkThinking(input,'native');return budget.run(input,input.inferenceConfig.maxTokens,async()=>{
  const step=budget.snapshot().startedSteps;
  try{const raw=await surface.converse(input,signal);const result=raw as {output?:unknown;usage?:unknown;stopReason?:unknown};observe?.({channel:'extraction_or_probe',phase:'returned',step,output:result.output,usage:result.usage,stopReason:result.stopReason});return raw;}
  catch(error){observe?.({channel:'extraction_or_probe',phase:'failed',step,errorCategory:category(error)});throw error;}
 });}};
 return {model,surface:boundedSurface};
}
