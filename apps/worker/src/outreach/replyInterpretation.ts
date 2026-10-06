import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
import {routeOfTransport} from '@fss/domain/classification/routedTransport.ts';
import type {ClassifierRequest} from '@fss/domain/classification/prompt.ts';
import {centsOf} from '@fss/domain/research/pricing.ts';
import {buildRoutineReplyRequest,ROUTINE_REPLY_OUTPUT_SCHEMA,type RoutineReplyInput} from '@fss/domain/outreach/replyPolicy.ts';
import {ROUTINE_REPLY_MODEL} from '@fss/domain/outreach/replyRequests.ts';
import type {RoutineReplyPort} from '@fss/domain/outreach/replyRun.ts';
export function routineReplyInterpretation(transport:AnthropicMessagesTransport):RoutineReplyPort {
 const request=(input:RoutineReplyInput):ClassifierRequest=>{const built=buildRoutineReplyRequest(input);if(!built||routeOfTransport(transport)(ROUTINE_REPLY_MODEL)!=='bedrock')throw new Error('credit_route_unavailable');return {model:ROUTINE_REPLY_MODEL,max_tokens:1024,system:[{type:'text',text:built.system}],messages:built.messages,output_config:{format:{type:'json_schema',schema:ROUTINE_REPLY_OUTPUT_SCHEMA}}};};
 return {providerKey:'aws_bedrock.outreach_reply',countInputTokens:async input=>transport.countTokens(request(input)),interpret:async input=>{
  const answer=await transport.create(request(input)),u=answer.usage;
  const valid=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  const estimated=!valid(u?.input_tokens)||!valid(u?.output_tokens)||!valid(u?.cache_read_input_tokens??0)||!valid(u?.cache_creation_input_tokens??0);
  return {raw:answer.stop_reason==='end_turn'?answer.content?.filter(b=>b.type==='text').map(b=>b.text??'').join('')??'':'',costEstimated:estimated,costCents:estimated?0:centsOf(ROUTINE_REPLY_MODEL,{inputTokens:u!.input_tokens!,outputTokens:u!.output_tokens!,cacheReadTokens:u?.cache_read_input_tokens??0,cacheWriteTokens:u?.cache_creation_input_tokens??0},'bedrock')};
 }};
}
