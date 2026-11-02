import type {QualificationFact} from '@fss/contracts';
import {providerErrorOf} from '@fss/domain/classification/providerError.ts';
import {preparedIdentityCitationRoles} from '@fss/domain/sourcing/preparedIdentity.ts';
import {preparedOnlySelection} from '@fss/domain/sourcing/qualificationCitationRoles.ts';
import {QUALIFICATION_PROVIDER_KEY,isPricedQualificationModel,qualificationCents} from '@fss/domain/sourcing/qualificationModel.ts';
import {qualificationRequest,qualificationSelectionSchema,QUALIFICATION_FACT_LIMIT,QUALIFICATION_SCHEMA_TOKEN_ALLOWANCE,type QualificationExtractionProvider} from '@fss/domain/sourcing/qualificationPrompt.ts';

const selectionSchema=qualificationSelectionSchema.shape.selections.element;
import {normalizeQualificationExtractionDiagnostic,type QualificationExtractionDiagnostic} from '@fss/domain/sourcing/qualificationDiagnostics.ts';
import {modelProcessEnabled} from '../handlers/classify.ts';
import {loadVertexGeminiSurface,readVertexConfig,type GeminiResponse,type GeminiSurface} from './vertexGemini.ts';

/** Map known schema positions only. Neither Zod messages nor unknown path/key names survive. */
function schemaDiagnostic(issue:{code:string;path:readonly PropertyKey[]}|undefined):Pick<QualificationExtractionDiagnostic,'code'|'schemaField'|'selectionIndex'> {
 const codes:Record<string,QualificationExtractionDiagnostic['code']>={invalid_type:'schema_invalid_type',invalid_value:'schema_invalid_value',invalid_format:'schema_invalid_format',unrecognized_keys:'schema_unrecognized_fields',too_big:'schema_over_bound',too_small:'schema_under_bound'};
 const path=issue?.path??[],first=path[0],index=path[1],field=path[2];
 let schemaField:QualificationExtractionDiagnostic['schemaField']='root';
 if(first==='openingQuestion'&&path.length===1)schemaField='openingQuestion';
 if(first==='selections'){
  schemaField='selections';
  if(typeof index==='number')schemaField='selection';
  if(path.length===3&&(field==='kind'||field==='observationId'||field==='blockId'))schemaField=field;
 }
 return {code:codes[issue?.code??'']??'schema_invalid',schemaField,...(first==='selections'&&typeof index==='number'?{selectionIndex:index}:{})};
}
const validCount=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
/** Vertex's finish reasons that mean the model declined or was blocked, as opposed to ran out of tokens. */
const REFUSAL_FINISH_REASONS=['SAFETY','BLOCKLIST','PROHIBITED_CONTENT','SPII','RECITATION','IMAGE_SAFETY','IMAGE_PROHIBITED_CONTENT','IMAGE_RECITATION'];
/**
 * What the call billed, or undefined when the answer does not say. Reasoning tokens are billed
 * as output: they are `thoughtsTokenCount` when reported separately, and otherwise inside the
 * total, so output is the larger of candidates plus thoughts and total minus prompt.
 */
function billedUsage(usage:GeminiResponse['usageMetadata']):{inputTokens:number;outputTokens:number}|undefined {
 const prompt=usage?.promptTokenCount,candidates=usage?.candidatesTokenCount,thoughts=usage?.thoughtsTokenCount,total=usage?.totalTokenCount;
 if(!validCount(prompt)||!(validCount(candidates)||validCount(thoughts)||validCount(total)))return undefined;
 const reported=(validCount(candidates)?candidates:0)+(validCount(thoughts)?thoughts:0);
 return {inputTokens:prompt,outputTokens:Math.max(reported,validCount(total)?Math.max(0,total-prompt):0)};
}
export function qualificationExtraction(surface:GeminiSurface):QualificationExtractionProvider {
 return {providerKey:QUALIFICATION_PROVIDER_KEY,
 // Vertex counts the prompt but not the response schema it injects; the allowance keeps the reservation above what the call bills.
 countInputTokens:async input=>{
  if(!isPricedQualificationModel(input.modelName))throw new Error('credit_route_unavailable');
  const {systemInstruction,contents}=qualificationRequest(input);
  return await surface.countTokens({systemInstruction,contents})+QUALIFICATION_SCHEMA_TOKEN_ALLOWANCE;
 },
 extract:async input=>{
  if(!isPricedQualificationModel(input.modelName))return {ok:false,failureCode:'credit_route_unavailable',costCents:0};
  let response:GeminiResponse;
  try{response=await surface.generate(qualificationRequest(input));}catch(error){
   return providerErrorOf(error).refused?{ok:false,failureCode:'provider_refused',costCents:0}:{ok:false,failureCode:'provider_error',costCents:0,costEstimated:true};
  }
  const usage=billedUsage(response.usageMetadata);
  const costEstimated=usage===undefined;
  const costCents=usage===undefined?0:qualificationCents(input.modelName,usage,new Date().toISOString());
  const cost={costCents,...(costEstimated?{costEstimated:true}:{})};
  const candidate=response.candidates?.[0];
  const finish=candidate?.finishReason;
  if(response.promptFeedback?.blockReason!==undefined||REFUSAL_FINISH_REASONS.some(reason=>reason===finish))return {ok:false,failureCode:'model_refusal',...cost};
  const stopReason=finish===undefined?undefined:finish==='STOP'?'end_turn' as const:finish==='MAX_TOKENS'?'max_tokens' as const:'other' as const;
  const rejected=(failureCode:'malformed_answer'|'invalid_evidence',detail:unknown,preparedFacts:readonly QualificationFact[]=[])=>{
   const diagnostic=normalizeQualificationExtractionDiagnostic(detail,input.observations);
   return {ok:false as const,failureCode,...cost,...(diagnostic?{diagnostic}:{}),...(preparedFacts.length?{preparedFacts:[...preparedFacts]}:{})};
  };
  let decoded:unknown;
  try{decoded=JSON.parse((candidate?.content?.parts??[]).filter(p=>p.thought!==true).map(p=>p.text??'').join(''));}catch{return rejected('malformed_answer',{stage:'json',code:'json_invalid',stopReason});}
  const resolve=(selected:{kind:QualificationFact['kind'];observationId:string;blockId:string})=>{
   const source=input.observations.find(s=>s.id===selected.observationId),block=source?.blocks.find(b=>b.id===selected.blockId);
   return {code:!source?'observation_unoffered' as const:!block?'block_missing' as const:block.text.length>2000?'block_over_bound' as const:null,fact:block?{...selected,value:block.text}:null};
  };
  // Business judgment survives any refusal: each residential_management selection is validated on its own, so a sibling
  // that breaks the schema or a citation rule refuses the answer for every citation reader but never these selections,
  // which the run keeps for the prepared brief only. At most the fact bound of them.
  const raw=typeof decoded==='object'&&decoded!==null&&'selections' in decoded&&Array.isArray(decoded.selections)?decoded.selections:undefined;
  const judged=(raw??[]).flatMap(value=>{
   const selected=selectionSchema.safeParse(value);if(!selected.success||selected.data.kind!=='residential_management')return [];
   const {code,fact}=resolve(selected.data);return code===null&&fact?[fact]:[];
  }).slice(0,QUALIFICATION_FACT_LIMIT);
  const parsed=qualificationSelectionSchema.safeParse(decoded);
  if(!parsed.success)return rejected('invalid_evidence',{stage:'schema',...schemaDiagnostic(parsed.error.issues[0]),selectionCount:raw?.length,stopReason},judged);
  const facts:QualificationFact[]=[];
  const selectionCount=parsed.data.selections.length;
  let refused:unknown;
  for(const [selectionIndex,selected] of parsed.data.selections.entries()){
   const {code,fact}=resolve(selected);
   if(code!==null||!fact){refused??={stage:'selection',selectionIndex,selectionCount,observationId:selected.observationId,blockId:selected.blockId,stopReason,code};continue;}
   facts.push(fact);
  }
  if(refused!==undefined)return rejected('invalid_evidence',refused,judged);
  // A truncated page or a moved company site's page (ADR0034) is no citation source: its residential_management selections
  // are kept for the prepared brief only, other kinds there are dropped; every remaining selection keeps the citation rules.
  const preparedOnly=facts.filter(fact=>preparedOnlySelection(input.candidate,fact,input.observations));
  const roles=preparedIdentityCitationRoles(input.candidate,facts.filter(fact=>!preparedOnly.includes(fact)),input.observations,input.producerVersion);
  if(!roles.ok)return rejected(roles.reason,{...roles.diagnostic,stopReason},judged);
  // The stored facts keep the one bound: prepared-only selections fill what the citations leave.
  const kept=preparedOnly.filter(fact=>fact.kind==='residential_management').slice(0,Math.max(0,QUALIFICATION_FACT_LIMIT-roles.facts.length));
  return {ok:true,value:{facts:[...roles.facts,...kept],openingQuestion:parsed.data.openingQuestion,...(roles.preparedIdentity?{preparedIdentity:roles.preparedIdentity}:{})},...cost};
 }};
}
/**
 * Qualification's model route for this deployment: Vertex only, from `FSS_VERTEX_*`. Absent
 * configuration is `extraction: null` (the worker then composes no qualification, and a run that
 * does start finishes `credit_route_unavailable`), never Bedrock. `FSS_CLASSIFIER=off` composes none
 * either, before any Vertex load, with or without a classifier transport. `problem` names a variable.
 */
export async function readQualificationComposition(environment:Readonly<Record<string,string|undefined>>,load:typeof loadVertexGeminiSurface=loadVertexGeminiSurface):Promise<{extraction:QualificationExtractionProvider|null;problem:string|null}> {
 if(!modelProcessEnabled(environment))return {extraction:null,problem:'FSS_CLASSIFIER'};
 const {config,problem}=readVertexConfig(environment);
 if(config===null)return {extraction:null,problem};
 try{return {extraction:qualificationExtraction(await load(config)),problem:null};}catch{return {extraction:null,problem:'vertex_load_failed'};}
}
