import {expect,it,vi} from 'vitest';
import {SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE} from '@fss/contracts';
import {PRIVATE_VOICE_GUIDE_VERSION,socialVoicePortAllowed} from '@fss/domain/social/voiceGeneration.ts';
import {buildSocialDraftRequest,SOCIAL_DRAFT_LIMITS,type SocialDraftInput} from '@fss/domain/social/draftPolicy.ts';
import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
import {socialDraftModel} from '../src/social/draftModel.ts';
const guideId='10000000-0000-4000-8000-000000000001',entryId='20000000-0000-4000-8000-000000000002',factId='30000000-0000-4000-8000-000000000003';
function input():SocialDraftInput{return {mode:'linkedin_grounded',voiceGuideProcessingScope:SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE,themes:[],
 privateVoiceGuide:{guideId,revision:7,entries:[{entryId,dimension:'tone',guidance:'Write direct conversational paragraphs.'}]},
 facts:[{id:factId,version:2,kind:'product',text:'A private draft workspace is planned.',socialInput:{topic:'build',status:'planned',sanitized:true}}]};}
function fixture(){
 const create=vi.fn<AnthropicMessagesTransport['create']>().mockResolvedValue({stop_reason:'end_turn',content:[{type:'text',text:'{"concepts":[]}'}],usage:{input_tokens:100,output_tokens:20}}),countTokens=vi.fn<AnthropicMessagesTransport['countTokens']>().mockResolvedValue(100);
 return {create,countTokens,port:socialDraftModel({kind:'bedrock',create,countTokens})};
}
it('real adapter declares its fixed processing scope and refuses saved/old guide selection before any provider work',async()=>{
 const f=fixture(),old=input();delete old.voiceGuideProcessingScope;
 expect(f.port.privateVoiceGuideVersion).toBe(PRIVATE_VOICE_GUIDE_VERSION);expect(f.port.privateVoiceGuideProcessingScope).toBe(SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE);
 expect(socialVoicePortAllowed({mode:'linkedin_grounded',sourceRefs:[],factBlocks:[],voiceGuideRef:{guideId,revision:7}},f.port)).toBe(false);
 expect(()=>f.port.countInputTokens(old)).toThrow('voice_guide_processing_scope_unavailable');await expect(f.port.generate(old)).rejects.toThrow('voice_guide_processing_scope_unavailable');
 expect(f.countTokens).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
});
it.each(['wrong-scope','wrong-mode','missing-guide'] as const)('adapter defense refuses %s even if an internal caller skips request parsing',async kind=>{
 const f=fixture(),source=input();if(kind==='wrong-scope')Object.assign(source,{voiceGuideProcessingScope:'another_provider'});if(kind==='wrong-mode')delete source.mode;if(kind==='missing-guide')delete source.privateVoiceGuide;
 expect(()=>f.port.countInputTokens(source)).toThrow('voice_guide_processing_scope_unavailable');await expect(f.port.generate(source)).rejects.toThrow('voice_guide_processing_scope_unavailable');expect(f.countTokens).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
});
it('counts and generates the same scoped bounded request, minimizing private guidance to dimension and text',async()=>{
 const f=fixture(),source=input();Object.assign(source.privateVoiceGuide!,{ownerUserId:'PRIVATE-OWNER',privateNote:'PRIVATE-NOTE'});
 expect(await f.port.countInputTokens(source)).toBe(100);expect(await f.port.generate(source)).toMatchObject({costCents:1,costEstimated:false});
 const request=f.create.mock.calls[0]?.[0];expect(request).toEqual(f.countTokens.mock.calls[0]?.[0]);expect(request).toMatchObject({model:'claude-haiku-4-5',max_tokens:4096});
 const payload=JSON.parse(request!.messages[0]!.content);expect(payload.untrustedStylePreferences).toEqual([{dimension:'tone',guidance:'Write direct conversational paragraphs.'}]);expect(payload.approvedFacts).toEqual(source.facts);
 const text=JSON.stringify(request);for(const privateMetadata of [guideId,entryId,'PRIVATE-OWNER','PRIVATE-NOTE','voiceGuideProcessingScope'])expect(text).not.toContain(privateMetadata);expect(text).toContain(factId);
 expect(f.create).toHaveBeenCalledTimes(1);expect(f.countTokens).toHaveBeenCalledTimes(1);
});
it('keeps local/private facts narrow and sends the no-inferred-guarantees instruction as trusted system guidance for both count and generation',async()=>{
 const f=fixture(),source=input();
 source.facts[0]!.text='A draft workspace runs locally for private editing.';source.facts[0]!.socialInput!.status='local';
 await f.port.countInputTokens(source);await f.port.generate(source);
 const counted=f.countTokens.mock.calls[0]?.[0],generated=f.create.mock.calls[0]?.[0];expect(generated).toEqual(counted);
 const system=generated!.system?.map(block=>block.text).join('');
 expect(system).toContain('Local/private labels establish only the exact approved fact.');
 expect(system).toContain('Do not infer architecture, network/data flows, storage, security, privacy, consent or sharing guarantees.');
 expect(system).toContain("runs locally for private editing does not support nothing leaves your computer unless you choose to share it");
 expect(system).toContain('Omit implications unless an approved fact explicitly supports the particular guarantee; if a draft depends on an unsupported implication, return an empty concepts array for review.');
 expect(JSON.parse(generated!.messages[0]!.content).approvedFacts).toEqual(source.facts);
 expect(f.create).toHaveBeenCalledTimes(1);expect(f.countTokens).toHaveBeenCalledTimes(1);
});
it('counts the grounding clarification inside the existing context bound before any provider work',async()=>{
 const f=fixture(),source=input(),built=buildSocialDraftRequest(source);if(!built)throw new Error('Controlled source missing');
 const remaining=SOCIAL_DRAFT_LIMITS.contextBytes-Buffer.byteLength(built.system+built.messages.map(message=>message.content).join(''));
 source.facts[0]!.text+='x'.repeat(remaining);expect(buildSocialDraftRequest(source)).not.toBeNull();
 expect(()=>f.port.countInputTokens(source)).toThrow('input_over_budget');await expect(f.port.generate(source)).rejects.toThrow('input_over_budget');
 expect(f.countTokens).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
});
it('existing Bedrock-only and context bounds still fence a scoped request before counting or generating',async()=>{
 const f=fixture(),source=input(),direct=socialDraftModel({kind:'anthropic',create:f.create,countTokens:f.countTokens});
 expect(()=>direct.countInputTokens(source)).toThrow('credit_route_unavailable');await expect(direct.generate(source)).rejects.toThrow('credit_route_unavailable');
 source.facts=Array.from({length:20},()=>({...source.facts[0]!,text:'x'.repeat(1300)}));
 expect(()=>f.port.countInputTokens(source)).toThrow('input_over_budget');await expect(f.port.generate(source)).rejects.toThrow('input_over_budget');expect(f.countTokens).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
});
it('ambiguous provider error is not retried or sent to a fallback model',async()=>{
 const f=fixture(),failure=new Error('fictional lost provider response');f.create.mockRejectedValue(failure);
 await expect(f.port.generate(input())).rejects.toBe(failure);expect(f.create).toHaveBeenCalledTimes(1);
});
