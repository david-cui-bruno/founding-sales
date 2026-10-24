import {candidateInputSchema,discoveryCandidatePayloadSchema,discoveryOriginSchema,discoverySourceKey,manualProspectSchema,type ManualProspect} from '@fss/contracts';

export interface ManualProspectRow extends Record<string,unknown> {
 id:string; revision:number; payload:unknown; origins:unknown; created_at:Date;
 manual_state:string; duplicate_count:number;
}
export function safeManualReference(value:string|null):string|null {
 if(value===null)return null;
 try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
/** Only structured retained fields. A phone-evidence label or prose is not a number. */
export function projectManualProspect(row:ManualProspectRow):ManualProspect|null {
 const ordinary=candidateInputSchema.safeParse(row.payload),discovery=discoveryCandidatePayloadSchema.safeParse(row.payload);
 const common={candidateId:row.id,revision:row.revision,retainedAt:row.created_at.toISOString(),state:row.manual_state,
  observedPhone:null,phoneBasis:'unknown',possibleDuplicateCount:row.duplicate_count,
  unknowns:['Phone unknown','Identity and fit unverified','Contact authority not granted'],qualification:'unverified',contactAuthority:'not_granted'};
 if(ordinary.success){const p=ordinary.data;return manualProspectSchema.parse({...common,observedName:p.firmName,website:safeManualReference(p.website),locality:p.locality,region:p.region,
  sources:[{label:p.preparedBy,url:safeManualReference(p.sourceUrl),observedAt:null}],sourceNotices:[]});}
 if(!discovery.success||!Array.isArray(row.origins))return null;
 const origins=row.origins.map(value=>discoveryOriginSchema.safeParse(value));
 if(origins.some(value=>!value.success)||origins.length!==discovery.data.row.observations.length)return null;
 const parsed=origins.flatMap(value=>value.success?[value.data]:[]),p=discovery.data.row;
 if(p.observations.some(source=>!parsed.some(origin=>discoverySourceKey(origin.source)===discoverySourceKey(source)&&JSON.stringify(origin.source)===JSON.stringify(source))))return null;
 const notices=parsed.flatMap(origin=>[...origin.licenses.map(label=>({label,url:null})),...origin.notices.map(notice=>({label:notice.label,url:safeManualReference(notice.url)}))]);
 const unique=[...new Map(notices.map(notice=>[JSON.stringify(notice),notice])).values()];
 // Never silently truncate a source's mandatory licensing notices.
 if(unique.length>256)return null;
 return manualProspectSchema.parse({...common,observedName:p.firmName,website:safeManualReference(p.website),locality:p.locality,region:p.region,
  sources:parsed.map(origin=>({label:`${origin.source.provider} · ${origin.source.release}`,url:safeManualReference(origin.source.sourceUrl),observedAt:origin.source.retrievedAt})),sourceNotices:unique});
}
