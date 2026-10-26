import type {ManualProspect,ProspectPhoneDiscoveryView} from '@fss/contracts';
import {prospectPhoneDiscoveryViewSchema} from '@fss/contracts';
import {scanManualLiteralPhones,type LiteralAuthority} from './manualProspectLiteralPhone.ts';
import type {PhoneDiscoveryRun} from './prospectPhoneDiscoveryStore.ts';

type Evidence=NonNullable<ManualProspect['phoneEvidence']>;
const missing=(reason:Extract<Evidence,{state:'not_extracted'}>['reason']):Evidence=>({state:'not_extracted',reason});
/** The guarded public fetch is a provider original, not a qualification lineage. */
export function projectProspectPhoneDiscovery(run:PhoneDiscoveryRun,now:number):Evidence{
 if(run.state!=='complete'||!run.content||run.expires_at.getTime()<=now)return missing('no_current_permitted_phone_evidence');
 const authority:LiteralAuthority={kind:'phone_discovery',runId:run.id,expiresAt:run.expires_at.toISOString()};
 const scan=scanManualLiteralPhones({runId:run.id,observations:run.content.observations,website:run.content.website,
  authorities:Object.fromEntries(run.content.observations.map(source=>[source.id,authority])),lineage:{kind:'provider_original'},now});
 if(scan.reason)return {state:'not_extracted',reason:scan.reason,coverage:scan.coverage};
 if(scan.unresolved)return {state:'conflicting',reason:'unresolved_retained_literal',sources:scan.sources,coverage:scan.coverage,...(scan.diagnostics?{diagnostics:scan.diagnostics}:{})};
 const numbers=[...new Set(scan.sources.flatMap(source=>source.normalizedValue?[source.normalizedValue]:[]))];
 if(numbers.length>1)return {state:'conflicting',reason:'multiple_retained_numbers',sources:scan.sources,coverage:scan.coverage};
 if(numbers.length===1)return {state:'observed',value:numbers[0]!,sources:scan.sources,coverage:scan.coverage};
 return {state:'not_extracted',reason:'retained_text_not_extracted',coverage:scan.coverage};
}
/** A missing operation changes nothing. A lost/changed existing operation cannot pick a survivor. */
export function composeProspectPhoneDiscovery(legacy:Evidence,discovered:Evidence|null):Evidence{
 if(!discovered)return legacy;
 if(legacy.coverage&&legacy.coverage.state!=='complete')return legacy;
 if(discovered.state==='not_extracted'&&discovered.coverage?.state!=='complete')return discovered;
 if(legacy.state==='not_extracted')return discovered;
 if(discovered.state==='not_extracted')return legacy;
 const sources:Extract<Evidence,{state:'observed'}>['sources']=[...(legacy.state==='observed'||legacy.state==='conflicting'?legacy.sources:[]),...(discovered.state==='observed'||discovered.state==='conflicting'?discovered.sources:[])];
 if(sources.length>16)return missing('bounded_scan_incomplete');
 const groups=[legacy,discovered].flatMap(evidence=>evidence.state==='conflicting'&&evidence.diagnostics?[evidence.diagnostics]:[]);
 const entries=groups.flatMap(group=>group.entries),retained=entries.slice(0,16);
 // Carry even omitted locations' deadlines. Explanation truncation cannot
 // extend the lifetime of a refusal or silently pick a surviving endpoint.
 const expiries=[...groups.flatMap(group=>group.expiresAt?[group.expiresAt]:[]),...entries.flatMap(entry=>entry.authority.kind==='phone_discovery'?[entry.authority.expiresAt]:[])];
 const expiresAt=expiries.sort((a,b)=>Date.parse(a)-Date.parse(b))[0];
 const diagnostics=groups.length?{diagnostics:{entries:retained,truncated:entries.length>16||groups.some(group=>group.truncated),...(expiresAt?{expiresAt}:{})}}:{};
 if(legacy.state==='conflicting'||discovered.state==='conflicting'||legacy.state==='absent'||discovered.state==='absent'||
  (legacy.state==='observed'&&discovered.state==='observed'&&legacy.value!==discovered.value))return {state:'conflicting',reason:'retained_source_ambiguous',sources,...(discovered.coverage?{coverage:discovered.coverage}:{}),...diagnostics};
 return legacy.state==='observed'?{...legacy,sources,...(discovered.coverage?{coverage:discovered.coverage}:{})}:discovered;
}
export function prospectPhoneDiscoveryView(run:PhoneDiscoveryRun,phoneEvidence:Evidence):ProspectPhoneDiscoveryView{
 return prospectPhoneDiscoveryViewSchema.parse({runId:run.id,candidateId:run.candidate_id,candidateRevision:run.candidate_revision,state:run.state,reason:run.reason,
  requestedAt:run.requested_at.toISOString(),checkedAt:run.checked_at?.toISOString()??null,expiresAt:run.expires_at.toISOString(),method:run.method,
  phoneEvidence,website:run.content?.website??null,channelAuthority:'not_granted'});
}
