import {useEffect,useState} from 'react';
import type {ManualProspect} from '@fss/contracts';

type PhoneEvidence=ManualProspect['phoneEvidence'];
function discoveryExpiry(evidence:PhoneEvidence):number{
 const sources=evidence?.state==='observed'||evidence?.state==='conflicting'?evidence.sources:[];
 const diagnostics=evidence?.state==='conflicting'?evidence.diagnostics?.entries??[]:[];
 const authorities=[...sources.flatMap(source=>'method' in source?[source.authority]:[]),...diagnostics.map(entry=>entry.authority)];
 const aggregate=evidence?.state==='conflicting'?evidence.diagnostics?.expiresAt:undefined;
 return Math.min(...(aggregate?[Date.parse(aggregate)]:[]),...authorities.flatMap(authority=>{
  if(authority.kind!=='phone_discovery')return [];
  const expiry=Date.parse(authority.expiresAt);return Number.isFinite(expiry)?[expiry]:[0];
 }));
}
/** Display-only expiry. Losing any dependency clears the whole enrichment, never a surviving winner. */
export function useCurrentPhoneEvidence(retained:PhoneEvidence):PhoneEvidence{
 const expiry=discoveryExpiry(retained),[,renderExpiry]=useState(0);
 // Local erasure only. Discovery authority is at most seven days, never renewed here.
 useEffect(()=>{
  const remaining=expiry-Date.now();if(!Number.isFinite(expiry)||remaining<=0)return;
  const timer=setTimeout(()=>renderExpiry(version=>version+1),remaining);
  return()=>clearTimeout(timer);
 },[expiry]);
 return expiry<=Date.now()?undefined:retained;
}
