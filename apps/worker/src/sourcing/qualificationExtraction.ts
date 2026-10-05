import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
import {routeOfTransport} from '@fss/domain/classification/routedTransport.ts';
import {providerErrorOf} from '@fss/domain/classification/providerError.ts';
import {centsOf} from '@fss/domain/research/pricing.ts';
import {qualificationRequest,qualificationSelectionSchema,type QualificationExtractionProvider} from '@fss/domain/sourcing/qualificationPrompt.ts';
export function qualificationExtraction(transport:AnthropicMessagesTransport):QualificationExtractionProvider {
 const route=routeOfTransport(transport);
 return {providerKey:'aws_bedrock.sourcing_qualification',
 countInputTokens:async input=>{if(route(input.modelName)!=='bedrock')throw new Error('credit_route_unavailable');return transport.countTokens(qualificationRequest(input));},
 extract:async input=>{
  if(route(input.modelName)!=='bedrock')return {ok:false,failureCode:'credit_route_unavailable',costCents:0};
  let response;
  try{response=await transport.create(qualificationRequest(input));}catch(error){
   return providerErrorOf(error).refused?{ok:false,failureCode:'provider_refused',costCents:0}:{ok:false,failureCode:'provider_error',costCents:0,costEstimated:true};
  }
  const usage=response.usage;
  const validCount=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  const costEstimated=!validCount(usage?.input_tokens)||!validCount(usage?.output_tokens);
  const costCents=costEstimated?0:centsOf(input.modelName,{inputTokens:usage!.input_tokens!,outputTokens:usage!.output_tokens!,cacheReadTokens:usage?.cache_read_input_tokens??0,cacheWriteTokens:usage?.cache_creation_input_tokens??0},'bedrock');
  const cost={costCents,...(costEstimated?{costEstimated:true}:{})};
  if(response.stop_reason==='refusal')return {ok:false,failureCode:'model_refusal',...cost};
  let decoded:unknown;
  try{decoded=JSON.parse(response.content?.find(b=>b.type==='text')?.text??'');}catch{return {ok:false,failureCode:'malformed_answer',...cost};}
  const parsed=qualificationSelectionSchema.safeParse(decoded);
  if(!parsed.success)return {ok:false,failureCode:'invalid_evidence',...cost};
  const facts=[];
  for(const selected of parsed.data.selections){
   const source=input.observations.find(s=>s.id===selected.observationId);
   const block=source?.blocks.find(b=>b.id===selected.blockId);
   if(!block||block.text.length>2000)return {ok:false,failureCode:'invalid_evidence',...cost};
   facts.push({...selected,value:block.text});
  }
  return {ok:true,value:{facts,openingQuestion:parsed.data.openingQuestion},...cost};
 }};
}
