import {randomUUID,createHash} from 'node:crypto';
import {socialDraftViewSchema,type SocialDraftRequest,type SocialPrivateDraftOrigin} from '@fss/contracts';
import type {RepositoryContext} from '../../db/workspaceScope.ts';
import {saveAnswerBlock,approveAnswerBlock} from '../../outreach/facts.ts';
import {saveSocialVoicePreferences} from '../../social/voicePreferences.ts';
import {socialDraftView} from '../../social/draftWorkspace.ts';
import {readSocialDraftRequest,requestSocialDrafts} from '../../social/drafts.ts';
import type {SocialDraftInput} from '../../social/draftPolicy.ts';
import type {SocialDraftPort} from '../../social/draftRun.ts';
import {PRIVATE_VOICE_GUIDE_VERSION} from '../../social/voiceGeneration.ts';
export const voiceEntries=()=>[{entryId:randomUUID(),dimension:'tone' as const,guidance:'Prefer neutral precise sentences, with meaningful paragraph spacing.'}];
export const voiceText='A local draft workspace is planned.\n\nKeeping a draft separate from a public action makes the boundary easier to inspect. A private edit remains a private edit, not shipped behavior.';
/** Real owner/guide/fact policy owners. Call inside an ordinary transaction. */
export async function voiceGenerationSelection(ctx:RepositoryContext):Promise<SocialDraftRequest>{
 const guide=await saveSocialVoicePreferences(ctx,{operation:'create',entries:voiceEntries()},async()=>true);if(!guide.ok)throw Error(guide.reason);
 const fact=await saveAnswerBlock(ctx,{kind:'product',text:'A local draft workspace is planned.',socialInput:{topic:'build',status:'planned',sanitized:true}});if(!fact.ok)throw Error(fact.reason);
 const approved=await approveAnswerBlock(ctx,fact.value);if(!approved.ok)throw Error(approved.reason);
 return {mode:'linkedin_grounded',sourceRefs:[],factBlocks:[{id:fact.value.id,version:1}],voiceGuideRef:guide.value};
}
export async function queueVoiceGeneration(ctx:RepositoryContext){
 const selection=await voiceGenerationSelection(ctx),requested=await requestSocialDrafts(ctx,selection,async()=>true);if(!requested.ok)throw Error(requested.reason);
 return {selection,requestId:requested.value.requestId};
}
export function fakeVoicePort(hooks:{count?:(input:SocialDraftInput)=>Promise<void>;generate?:(input:SocialDraftInput)=>Promise<void>;unknown?:boolean}={}):SocialDraftPort{
 return {providerKey:'aws_bedrock.social_draft',privateVoiceGuideVersion:PRIVATE_VOICE_GUIDE_VERSION,
 countInputTokens:async input=>{await hooks.count?.(input);return 100;},
 generate:async input=>{await hooks.generate?.(input);if(hooks.unknown)throw Error('Controlled unknown model result');return {raw:JSON.stringify({concepts:[{theme:'build',factRefs:input.facts.map(({id,version})=>({id,version})),variants:[{platform:'linkedin',text:voiceText}]}]}),costCents:1,costEstimated:false};}};
}
export async function voiceOrigin(ctx:RepositoryContext,requestId:string):Promise<Extract<SocialPrivateDraftOrigin,{kind:'suggestion'}>>{
 const row=await readSocialDraftRequest(ctx,requestId);if(!row||row.state!=='ready')throw Error('Expected current ready request');
 const request=socialDraftViewSchema.parse(socialDraftView(row));
 return {kind:'suggestion',requestId,conceptIndex:0,variantIndex:0,selectionSHA256:createHash('sha256').update(JSON.stringify({request,conceptIndex:0,variantIndex:0})).digest('hex')};
}
