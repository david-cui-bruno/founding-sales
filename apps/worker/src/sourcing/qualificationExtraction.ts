import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
import {routeOfTransport} from '@fss/domain/classification/routedTransport.ts';
import {providerErrorOf} from '@fss/domain/classification/providerError.ts';
import {centsOf} from '@fss/domain/research/pricing.ts';
import {qualificationExtractionCitationRoles} from '@fss/domain/sourcing/qualificationCitationRoles.ts';
import {qualificationRequest,qualificationSelectionSchema,type QualificationExtractionProvider} from '@fss/domain/sourcing/qualificationPrompt.ts';
import {normalizeQualificationExtractionDiagnostic,type QualificationExtractionDiagnostic} from '@fss/domain/sourcing/qualificationDiagnostics.ts';

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
  const stop=response.stop_reason;
  const stopReason=stop===undefined||stop===null?undefined:['end_turn','max_tokens','stop_sequence','tool_use','pause_turn','refusal'].includes(stop)?stop:'other';
  const rejected=(failureCode:'malformed_answer'|'invalid_evidence',detail:unknown)=>{
   const diagnostic=normalizeQualificationExtractionDiagnostic(detail,input.observations);
   return {ok:false as const,failureCode,...cost,...(diagnostic?{diagnostic}:{})};
  };
  let decoded:unknown;
  try{decoded=JSON.parse(response.content?.find(b=>b.type==='text')?.text??'');}catch{return rejected('malformed_answer',{stage:'json',code:'json_invalid',stopReason});}
  const parsed=qualificationSelectionSchema.safeParse(decoded);
  if(!parsed.success){
   const selections=typeof decoded==='object'&&decoded!==null&&'selections' in decoded&&Array.isArray(decoded.selections)?decoded.selections:undefined;
   return rejected('invalid_evidence',{stage:'schema',...schemaDiagnostic(parsed.error.issues[0]),selectionCount:selections?.length,stopReason});
  }
  const facts=[];
  const selectionCount=parsed.data.selections.length;
  for(const [selectionIndex,selected] of parsed.data.selections.entries()){
   const source=input.observations.find(s=>s.id===selected.observationId);
   const block=source?.blocks.find(b=>b.id===selected.blockId);
   const detail={stage:'selection',selectionIndex,selectionCount,observationId:selected.observationId,blockId:selected.blockId,stopReason};
   if(!source)return rejected('invalid_evidence',{...detail,code:'observation_unoffered'});
   if(!block)return rejected('invalid_evidence',{...detail,code:'block_missing'});
   if(block.text.length>2000)return rejected('invalid_evidence',{...detail,code:'block_over_bound'});
   facts.push({...selected,value:block.text});
  }
  const roles=qualificationExtractionCitationRoles(input.candidate,facts,input.observations);
  if(!roles.ok)return rejected(roles.reason,{...roles.diagnostic,stopReason});
  return {ok:true,value:{facts:roles.facts,openingQuestion:parsed.data.openingQuestion},...cost};
 }};
}
