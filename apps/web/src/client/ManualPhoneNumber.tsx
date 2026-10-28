import {useEffect,useState,type JSX} from 'react';
import type {ManualProspect} from '@fss/contracts';
export function useCurrentManualPhone(phone:ManualProspect['manualPhone']):ManualProspect['manualPhone']{
 const expiry=phone?Date.parse(phone.expiresAt):0,[,tick]=useState(0);
 useEffect(()=>{if(expiry<=Date.now())return;const timer=setTimeout(()=>tick(v=>v+1),Math.min(expiry-Date.now(),2_147_483_647));return()=>clearTimeout(timer);},[expiry]);
 return expiry>Date.now()?phone:undefined;
}
/** A saved human choice remains separate from an eligible canonical route. */
export function ManualPhoneNumber({phone:raw,compact=false}:{phone:ManualProspect['manualPhone'];compact?:boolean}):JSX.Element|null{
 const phone=useCurrentManualPhone(raw);if(!phone)return null;
 let href:string|undefined;try{const url=new URL(phone.sourceUrl);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)href=url.href;}catch{/* Source text is never executable. */}
 return compact?<span>Manual number {phone.value}</span>:<div aria-label="Chosen manual number"><p><strong>{phone.value}</strong> · chosen for manual review</p><p>Company identity, phone type and reachability remain unverified.</p>{href?<a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Number source</a>:<span>Source link unavailable</span>}<p>Source retrieved {phone.retrievedAt}</p></div>;
}
