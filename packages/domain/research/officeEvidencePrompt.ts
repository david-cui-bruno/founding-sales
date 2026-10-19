import {qualificationFactSchema} from '@fss/contracts';
import type {ClassifierRequest} from '../classification/prompt.ts';
import {qualificationRequest,qualificationSelectionSchema} from '../sourcing/qualificationPrompt.ts';
import type {OfficeExtractionRequest,OfficeSelection} from './officeAssessmentContract.ts';
import {MAX_EXTRACTION_OUTPUT_TOKENS} from './pricing.ts';
export function officeExtractionRequest(input:OfficeExtractionRequest):ClassifierRequest {
 const inherited=qualificationRequest({...input,maxInputTokens:0});
 return {model:input.modelName,max_tokens:Math.min(MAX_EXTRACTION_OUTPUT_TOKENS,input.maxOutputTokens),
 system:inherited.system.map(block=>({...block,text:block.text.replace(/openingQuestion is at most 240 characters, neutral and grounded; use null when unsure\./u,'Return only selectors, never questions or an opening.')})),
 messages:[{role:'user',content:JSON.stringify({candidate:input.candidate,observations:input.observations})}],
 output_config:{format:{type:'json_schema',schema:{type:'object',additionalProperties:false,required:['selections'],properties:{selections:{type:'array',items:{type:'object',additionalProperties:false,required:['kind','observationId','blockId'],properties:{kind:{type:'string',enum:qualificationFactSchema.shape.kind.options},observationId:{type:'string'},blockId:{type:'string'}}}}}}}}};
}
export function parseOfficeExtractionAnswer(text:string):OfficeSelection[]|null {
 try{const raw:unknown=JSON.parse(text);if(typeof raw!=='object'||!raw||Object.keys(raw).length!==1||!('selections' in raw))return null;const parsed=qualificationSelectionSchema.safeParse({selections:raw.selections,openingQuestion:null});return parsed.success?parsed.data.selections:null;}catch{return null;}
}
