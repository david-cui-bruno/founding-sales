// THROWAWAY: model-only view over already admitted synthetic native frames.
// No authority minting, source rewriting, source acquisition or product execution.
const owns=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>owns(value,key)).map(key=>[key,structuredClone(value[key])]));
function original(window,scope,attribution){
 if(!window||typeof window.id!=='string'||!/^w[1-9]\d*$/.test(window.id)||typeof window.text!=='string')throw new Error('original_not_admitted');
 const source=window.source;
 if(!source||!['selected_note','mail','call_transcript','meeting_transcript'].includes(source.kind))throw new Error('original_kind_missing');
 const associations=(scope?.sourceContexts??[]).filter(item=>item.sourceId===source.sourceId&&item.kind===source.kind);
 const reported=(attribution??[]).filter(item=>item.sourceId===source.sourceId&&item.kind===source.kind);
 return {id:window.id,kind:source.kind,text:window.text,navigation:pick(source,['sourceId','locator']),
  dates:window.sourceMetadata?structuredClone(window.sourceMetadata):{eventTime:{at:source.occurredAt??null,basis:source.kind==='selected_note'?'supplied_or_parsed_event_date':source.kind==='mail'?'retained_message_event_date':'record_event_date',independentlyVerifiedAuthoredTime:false},copyObservation:{at:source.observedAt??null,basis:'copy_observation_time'}},
  attribution:{humanAuthorship:'not_verified',reportedSpeaker:source.speaker??null,canonicalAssociations:associations,sourceLabels:reported},
  completeness:source.completeness??'unknown'};
}
export function compactResult(value){
 if(Array.isArray(value))return {originals:value.map(window=>original(window))};
 if(!value||typeof value!=='object')return value;
 // Authority must be a typed server field on an executed exact result. Source
 // prose containing identical strings cannot take this branch.
 const authority=value.evidenceAuthority;
 if(authority?.kind==='current_exact_crm_state'&&typeof authority.toolCallId==='string'&&/^e[1-9]\d*$/.test(authority.toolCallId)){
  const data=pick(value,Object.keys(value).filter(key=>!['evidenceAuthority','answerGuidance','scope','coverage'].includes(key)));
  return {observations:[{id:authority.toolCallId,operation:value.operation,queryScope:structuredClone(value.scope??null),value:data}],coverage:value.coverage?{exactQuery:structuredClone(value.coverage)}:{exactQuery:'unknown'}};
 }
 if(!Array.isArray(value.windows))return structuredClone(value); // Resolution/error results unchanged.
 const packet={originals:value.windows.map(window=>original(window,value.scope,value.attribution))};
 if(value.scope)packet.scope=pick(value.scope,['intent','records','sourceCount']);
 // No attempt to infer acquisition dates/channels from source text or scan flags.
 packet.coverage={...value.coverage?{selectedScan:structuredClone(value.coverage)}:{},retrieval:pick(value,['partial','preview','previewWindowLimit','sourceCeilingReached','retrieval','semantic','scannedCandidates']),mailboxDatesAndChannels:'not_established_by_this_read'};
 const navigation=pick(value,['nextAfter','nextAfterSourceId']);if(Object.keys(navigation).length)packet.navigation=navigation;
 return packet;
}
export function compactNativeBody(body){
 const result=structuredClone(body);
 for(const message of result.messages??[])for(const block of message.content??[]){
  if(typeof block.text==='string'){
   const input=JSON.parse(block.text);
   if(input&&typeof input.question==='string'&&Array.isArray(input.context))block.text=JSON.stringify({...input,context:input.context.map(compactResult)});
  }
  if(block.toolResult)for(const item of block.toolResult.content??[]){
   if(typeof item.text==='string')item.text=JSON.stringify(compactResult(JSON.parse(item.text)));
  }
 }
 return result;
}
