import {socialGuidedRequestInputSchema,type SocialDraftWorkspace,type SocialGuidedRequestInput,type SocialVoiceGuide} from '@fss/contracts';
type AvailableGuide=Extract<SocialVoiceGuide,{state:'available'}>;
type Fact=SocialDraftWorkspace['facts'][number];
export interface SocialGenerationSelection{guide:AvailableGuide;facts:Fact[]}
/** Only approved socialInput metadata is selectable, never retained call/meeting
 * prose or an arbitrary source selector. Refs derive from selected facts only. */
export function guidedSocialSelection(selection:SocialGenerationSelection):SocialGuidedRequestInput{
 if(selection.facts.some(fact=>!fact.socialInput?.sanitized)||new Set(selection.facts.map(fact=>fact.id)).size!==selection.facts.length)throw Error('Select approved factual inputs');
 const refs=selection.facts.flatMap(fact=>fact.socialInput?.sourceRef?[fact.socialInput.sourceRef]:[]);
 const sourceRefs=Array.from(new Map(refs.map(ref=>[`${ref.id}:${ref.revision}`,{kind:'public' as const,id:ref.id,revision:ref.revision}])).values());
 return socialGuidedRequestInputSchema.parse({mode:'linkedin_grounded',voiceGuideRef:{guideId:selection.guide.guideId,revision:selection.guide.revision},factBlocks:selection.facts.map(({id,version})=>({id,version})),sourceRefs});
}
/** A fresh read may refuse a changed selection, never silently upgrade it. */
export function revalidateSocialSelection(selection:SocialGenerationSelection,workspace:SocialDraftWorkspace,guide:SocialVoiceGuide):SocialGuidedRequestInput{
 if(guide.state!=='available'||JSON.stringify(guide)!==JSON.stringify(selection.guide))throw Error('Voice guide changed. Select current revision explicitly');
 for(const fact of selection.facts){const fresh=workspace.facts.find(value=>value.id===fact.id);if(!fresh||JSON.stringify(fresh)!==JSON.stringify(fact))throw Error('Selected factual input changed');}
 return guidedSocialSelection(selection);
}
