/** Throwaway paired reasoning policy. No production composition or dispatch. */
import {readFileSync} from 'node:fs';
import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import type {LanguageModelV3} from '@ai-sdk/provider';
import {z} from 'zod';
import {createAskSdkStepAdapter} from '../askAgentSdk.ts';

export type ReasoningMode='disabled'|'adaptive';
const object=(value:unknown)=>{const parsed=z.record(z.string(),z.json()).safeParse(value);return parsed.success?parsed.data:{};};
/** Rewrite before the underlying bounded adapter sees the provider request.
 * Adaptive thinking cannot use SDK required/specific tool choice. Both arms
 * therefore use auto, medium effort and the caller's unchanged token ceiling.
 */
export function wrapReasoningPolicy(model:LanguageModelV3,mode:ReasoningMode):LanguageModelV3{
 return {specificationVersion:model.specificationVersion,provider:model.provider,modelId:model.modelId,supportedUrls:model.supportedUrls,
  async doGenerate(input){
   const bedrock=object(input.providerOptions?.['bedrock']),additional=object(bedrock['additionalModelRequestFields']),existingReasoning=object(bedrock['reasoningConfig']);
   const {budgetTokens:_,...reasoning}=existingReasoning;void _;
   return model.doGenerate({...input,toolChoice:{type:'auto'},providerOptions:{...input.providerOptions,bedrock:{...bedrock,reasoningConfig:{...reasoning,type:mode,maxReasoningEffort:'medium'},additionalModelRequestFields:{...additional,thinking:{type:mode},output_config:{...object(additional['output_config']),effort:'medium'}}}}});
  },
  async doStream(){throw new Error('reasoning_prototype_stream_unsupported');},
 };
}

/** Offline actual-Converse capture through the pinned production SDK adapter.
 * Fake credentials and a fake HTTP responder prevent any network/provider use.
 */
export async function preflightReasoningPolicy(transcript?:readonly unknown[]){
 const fixture=z.object({cases:z.array(z.object({question:z.string(),transcript:z.array(z.unknown())}).passthrough())}).passthrough().parse(JSON.parse(readFileSync(new URL('./fixtures.json',import.meta.url),'utf8'))).cases[0];
 if(!fixture)throw new Error('reasoning_preflight_fixture_missing');
 const captures:{mode:ReasoningMode;request:unknown;acceptance:string;inputBytes:number}[]=[];
 for(const mode of ['disabled','adaptive'] as const){
  const requests:unknown[]=[];
  const raw=createAmazonBedrock({region:'us-east-1',credentialProvider:async()=>({accessKeyId:'offline-controlled',secretAccessKey:'offline-controlled'}),fetch:async(_url,init)=>{
   requests.push(JSON.parse(String(init?.body)) as unknown);
   return new Response(JSON.stringify({output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'offline-final',name:'emit_answer',input:{claims:[],abstained:true}}}]}},stopReason:'tool_use',usage:{inputTokens:30,outputTokens:10,totalTokens:40},metrics:{latencyMs:1}}),{headers:{'content-type':'application/json'}});
  }})('us.anthropic.claude-sonnet-4-6');
  const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:raw.modelId,providerKey:'offline-preflight',model:wrapReasoningPolicy(raw,mode)});
  const request={question:fixture.question,transcript:transcript??fixture.transcript,maxOutputTokens:4096,remainingSteps:1,signal:new AbortController().signal};
  const bound=adapter.inputBound?.(request);if(!bound)throw new Error('reasoning_preflight_input_bound');
  const result=await adapter.runStep(request);
  if(requests.length!==1)throw new Error('reasoning_preflight_call_count');
  const wire=z.object({inferenceConfig:z.object({maxTokens:z.literal(4096)}),toolConfig:z.object({toolChoice:z.object({auto:z.object({}).strict()}).strict()}),additionalModelRequestFields:z.object({thinking:z.object({type:z.literal(mode)}).strict(),output_config:z.object({effort:z.literal('medium')}).passthrough()}).passthrough()}).passthrough().parse(requests[0]);
  if(result.acceptance!=='accepted')throw new Error('reasoning_preflight_output_refused');
  captures.push({mode,request:wire,acceptance:result.acceptance,inputBytes:bound.inputBytes});
 }
 return captures;
}
