import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
import type {ClassifierRequest} from '@fss/domain/classification/prompt.ts';
import {routeOfTransport} from '@fss/domain/classification/routedTransport.ts';
import {centsOf} from '@fss/domain/research/pricing.ts';
import {SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE} from '@fss/contracts';
import {PRIVATE_VOICE_GUIDE_VERSION} from '@fss/domain/social/voiceGeneration.ts';
import {buildSocialDraftRequest,SOCIAL_DRAFT_MODEL,SOCIAL_DRAFT_LIMITS,SOCIAL_DRAFT_OUTPUT_SCHEMA,GROUNDED_SOCIAL_DRAFT_OUTPUT_SCHEMA,type SocialDraftInput} from '@fss/domain/social/draftPolicy.ts';
export interface SocialDraftModel {
 readonly providerKey:'aws_bedrock.social_draft';
 readonly privateVoiceGuideVersion:typeof PRIVATE_VOICE_GUIDE_VERSION;
 readonly privateVoiceGuideProcessingScope:typeof SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE;
 countInputTokens(input:SocialDraftInput):Promise<number>;
 generate(input:SocialDraftInput):Promise<{raw:string;costCents:number;costEstimated:boolean}>;
}
const groundedClaimBoundary=' Local/private labels establish only the exact approved fact. Do not infer architecture, network/data flows, storage, security, privacy, consent or sharing guarantees. For example, runs locally for private editing does not support nothing leaves your computer unless you choose to share it. Omit implications unless an approved fact explicitly supports the particular guarantee; if a draft depends on an unsupported implication, return an empty concepts array for review.';
/** Worker-only transport; dispatch must be preceded by a committed budget reservation. */
export function socialDraftModel(transport:AnthropicMessagesTransport):SocialDraftModel {
 const request=(input:SocialDraftInput):ClassifierRequest=>{
  if(routeOfTransport(transport)(SOCIAL_DRAFT_MODEL)!=='bedrock')throw new Error('credit_route_unavailable');
  if(input.privateVoiceGuide&&(input.mode!=='linkedin_grounded'||input.voiceGuideProcessingScope!==SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE))throw new Error('voice_guide_processing_scope_unavailable');
  if(input.voiceGuideProcessingScope!==undefined&&(!input.privateVoiceGuide||input.mode!=='linkedin_grounded'))throw new Error('voice_guide_processing_scope_unavailable');
  const built=buildSocialDraftRequest(input);if(!built)throw new Error('input_over_budget');
  const system=built.system+(input.mode==='linkedin_grounded'?groundedClaimBoundary:'');
  if(Buffer.byteLength(system+built.messages.map(message=>message.content).join(''))>SOCIAL_DRAFT_LIMITS.contextBytes)throw new Error('input_over_budget');
  return {model:SOCIAL_DRAFT_MODEL,max_tokens:SOCIAL_DRAFT_LIMITS.maxOutputTokens,system:[{type:'text',text:system}],messages:built.messages,output_config:{format:{type:'json_schema',schema:input.mode==='linkedin_grounded'?GROUNDED_SOCIAL_DRAFT_OUTPUT_SCHEMA:SOCIAL_DRAFT_OUTPUT_SCHEMA}}};
 };
 return {providerKey:'aws_bedrock.social_draft',privateVoiceGuideVersion:PRIVATE_VOICE_GUIDE_VERSION,privateVoiceGuideProcessingScope:SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE,countInputTokens:input=>transport.countTokens(request(input)),generate:async input=>{
  const answer=await transport.create(request(input)),u=answer.usage;
  const valid=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  const estimated=!valid(u?.input_tokens)||!valid(u?.output_tokens)||!valid(u?.cache_read_input_tokens??0)||!valid(u?.cache_creation_input_tokens??0);
  return {raw:answer.stop_reason==='end_turn'?answer.content?.filter(block=>block.type==='text').map(block=>block.text??'').join('')??'':'',costEstimated:estimated,costCents:estimated?0:centsOf(SOCIAL_DRAFT_MODEL,{inputTokens:u!.input_tokens!,outputTokens:u!.output_tokens!,cacheReadTokens:u?.cache_read_input_tokens??0,cacheWriteTokens:u?.cache_creation_input_tokens??0},'bedrock')};
 }};
}
