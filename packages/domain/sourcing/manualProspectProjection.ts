import {manualProspectPresentation} from './manualProspectPresentation.ts';
import {candidateInputSchema,discoveryCandidatePayloadSchema,discoveryOriginSchema,discoverySourceKey,manualProspectSchema,type ManualProspect} from '@fss/contracts';
import {z} from 'zod';

interface ManualProspectSourceRow extends Record<string,unknown> {
 id:string; revision:number; payload:unknown; origins:unknown; created_at:Date;
 manual_state:string;
}
export interface ManualProspectSubject extends ManualProspectSourceRow {source_urls:string[]}
export interface ManualProspectRow extends ManualProspectSourceRow {duplicate_count:number}
// A subject has no inventory-derived duplicate metadata. The generated subject
// projection always uses the default phone, so no selected-phone refinement is
// bypassed by validating just these shared presentation/source fields.
const subjectProjectionSchema=z.strictObject(manualProspectSchema.shape).omit({possibleDuplicateCount:true});
export function safeManualReference(value:string|null):string|null {
 if(value===null)return null;
 try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
const defaultPhone:NonNullable<ManualProspect['phoneEvidence']>={state:'not_extracted',reason:'no_retained_phone_field'};
/** Both authority and display use the same exact origin identity and notices. */
function manualProspectFields(row:ManualProspectSourceRow,phone:NonNullable<ManualProspect['phoneEvidence']>) {
 const ordinary=candidateInputSchema.safeParse(row.payload),discovery=discoveryCandidatePayloadSchema.safeParse(row.payload);
 const declared=discovery.success?discovery.data.row.officePhoneEvidence:'unknown';
 const phoneEvidence:NonNullable<ManualProspect['phoneEvidence']>=declared==='ambiguous'||(declared==='absent'&&phone.state==='observed')?
  {state:'conflicting',reason:'retained_source_ambiguous',sources:phone.state==='observed'||phone.state==='conflicting'?phone.sources:[],...(phone.coverage?{coverage:phone.coverage}:{})}:
  declared==='absent'&&phone.state!=='conflicting'&&(!phone.coverage||phone.coverage.state==='complete')?{state:'absent',basis:'retained_source_declares_absent',...(phone.coverage?{coverage:phone.coverage}:{})}:phone;
 const observed=phoneEvidence.state==='observed';
 const common={candidateId:row.id,revision:row.revision,retainedAt:row.created_at.toISOString(),state:row.manual_state,
  observedPhone:observed?phoneEvidence.value:null,phoneBasis:observed?'retained_observation':'unknown',phoneEvidence,
  unknowns:[observed?'Observed phone is not calling eligibility':'Phone unknown','Identity and fit unverified','Contact authority not granted'],qualification:'unverified',contactAuthority:'not_granted'};
 if(ordinary.success){const p=ordinary.data;return {ordinary:true,value:{...common,observedName:p.firmName,presentation:manualProspectPresentation(p.firmName,p.website),website:safeManualReference(p.website),locality:p.locality,region:p.region,
  sources:[{label:p.preparedBy,url:safeManualReference(p.sourceUrl),observedAt:null}],sourceNotices:[]}};}
 if(!discovery.success||!Array.isArray(row.origins))return null;
 const origins=row.origins.map(value=>discoveryOriginSchema.safeParse(value));
 if(origins.some(value=>!value.success)||origins.length!==discovery.data.row.observations.length)return null;
 const parsed=origins.flatMap(value=>value.success?[value.data]:[]),p=discovery.data.row;
 if(p.observations.some(source=>!parsed.some(origin=>discoverySourceKey(origin.source)===discoverySourceKey(source)&&JSON.stringify(origin.source)===JSON.stringify(source))))return null;
 const notices=parsed.flatMap(origin=>[...origin.licenses.map(label=>({label,url:null})),...origin.notices.map(notice=>({label:notice.label,url:safeManualReference(notice.url)}))]);
 const unique=[...new Map(notices.map(notice=>[JSON.stringify(notice),notice])).values()];
 // Never silently truncate a source's mandatory licensing notices.
 return {ordinary:false,value:{...common,observedName:p.firmName,presentation:manualProspectPresentation(p.firmName,p.website),website:safeManualReference(p.website),locality:p.locality,region:p.region,
  sources:parsed.map(origin=>({label:`${origin.source.provider} · ${origin.source.release}`,url:safeManualReference(origin.source.sourceUrl),observedAt:origin.source.retrievedAt})),sourceNotices:unique}};
}
/** Source authority is independent of navigational duplicate rank or page. */
export function manualProspectSubjectPermitted(row:ManualProspectSubject):boolean {
 const fields=manualProspectFields(row,defaultPhone);
 return fields!==null&&subjectProjectionSchema.safeParse(fields.value).success;
}
/** Only structured retained fields. A phone-evidence label or prose is not a number. */
export function projectManualProspect(row:ManualProspectRow,phone:NonNullable<ManualProspect['phoneEvidence']>=defaultPhone):ManualProspect|null {
 const fields=manualProspectFields(row,phone);
 if(!fields)return null;
 const value={...fields.value,possibleDuplicateCount:row.duplicate_count};
 if(fields.ordinary)return manualProspectSchema.parse(value);
 const projected=manualProspectSchema.safeParse(value);
 return projected.success?projected.data:null;
}
