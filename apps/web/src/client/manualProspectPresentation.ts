import type {ManualProspect} from '@fss/contracts';

/** Presentation only. Never promote missing or legacy evidence to an observed phone. */
export function manualPhoneLabel(p:ManualProspect):string{
 const evidence=p.phoneEvidence;
 if(evidence?.state==='observed')return `Phone ${evidence.value} · observed, not call-ready`;
 if(evidence?.state==='absent')return 'Phone absent · retained source explicitly declares absent';
 if(evidence?.state==='conflicting')return 'Phone conflicting · no number selected';
 return 'Phone unknown · not extracted';
}
export function manualProspectLabel(p:ManualProspect):string{return p.presentation?.label??p.observedName;}
export function manualProspectSite(p:ManualProspect):string|null{
 try{if(p.website){const url=new URL(p.website);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.hostname;}}catch{/* Retained references are never executed. */}
 return null;
}
