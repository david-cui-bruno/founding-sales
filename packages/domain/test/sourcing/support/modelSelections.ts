import type {QualificationFact,SourceObservation} from '@fss/contracts';
import type {QualificationExtractionProvider} from '../../../sourcing/qualificationPrompt.ts';
/** Fixture stand-in for the qualification model's residential-management judgment: a descriptive,
 * non-negated statement that someone manages residential or rental property. Tests choose their own. */
export const selectsManagement=(text:string)=>/\bmanag(?:e|es|ed|ing)\b[^.!?]*\b(?:residential|rental|homes|apartments|propert(?:y|ies))\b/iu.test(text)&&!/\b(?:do not|don't|does not|never|no longer)\b/iu.test(text);
/** The facts a run stores when the model selects these blocks as residential management. */
export function residentialFacts(observations:readonly SourceObservation[],select:(text:string)=>boolean=selectsManagement):QualificationFact[]{
 return observations.flatMap(source=>source.blocks.filter(block=>select(block.text)).map(block=>({kind:'residential_management' as const,value:block.text.slice(0,2000).trim(),observationId:source.id,blockId:block.id}))).slice(0,30);
}
/** A model call that answers with exactly those selections. */
export function selectingExtraction(select:(text:string)=>boolean=selectsManagement):QualificationExtractionProvider{
 return {providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async input=>({ok:true,costCents:1,value:{facts:residentialFacts(input.observations,select),openingQuestion:null}})};
}
