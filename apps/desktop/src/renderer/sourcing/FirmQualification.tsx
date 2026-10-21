import {useEffect,useState,type JSX} from 'react';
import type {OperationOutput} from '../../shared/operations.ts';
type FirmView=NonNullable<OperationOutput<'sourcing.firmQualification'>['view']>;
import {operations} from '../app/bridges.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {Button} from '../ui/button.tsx';
import {QualificationPanel} from './QualificationPanel.tsx';
export type FirmQualificationRead=(firmId:string)=>Promise<OperationOutput<'sourcing.firmQualification'>>;
const readFirm:FirmQualificationRead=async firmId=>{const api=operations();return api?api.read('sourcing.firmQualification',{firmId}):{view:null,reason:'unavailable'};};
/** Independent live read shared by Firm and expanded Today. Never uses Today cache. */
export function FirmQualification({firmId,enabled=true,online=true,read=readFirm}:{firmId:string;enabled?:boolean;online?:boolean;read?:FirmQualificationRead}):JSX.Element {
 const epoch=useSessionEpoch(),[refresh,setRefresh]=useState(0);
 const [value,setValue]=useState<{firmId:string;epoch:object|null;view:FirmView}|null>(null);
 const [expired,setExpired]=useState(false);
 useEffect(()=>{
  let active=true;setValue(null);setExpired(false);
  if(online)void read(firmId).then(answer=>{if(active)setValue(answer.view?{firmId,epoch,view:answer.view}:null);}).catch(()=>{if(active)setValue(null);});
  return()=>{active=false;};
 },[firmId,epoch,online,read,refresh]);
 const view=online&&value?.firmId===firmId&&value.epoch===epoch?value.view:null;
 const native=view?.nativeEligibility;
 useEffect(()=>{
  if(native?.status!=='verified')return;
  const remaining=Math.min(Date.parse(native.validUntil)-Date.now(),Date.parse(native.validUntil)-Date.parse(native.checkedAt));
  const timer=setTimeout(()=>setExpired(true),Math.max(0,remaining));
  return()=>clearTimeout(timer);
 },[native]);
 const verified=native?.status==='verified'&&!expired&&Date.parse(native.validUntil)>Date.now()&&native.firmId===firmId&&native.runId===view?.runId&&native.candidateRevision===view.candidateRevision;
 return <section aria-label="Current native Firm eligibility" className="space-y-2">
  <p>Native firm eligibility: {verified?'verified':!online?'unavailable offline':native?.status==='pending'?'pending':'unavailable'}</p>
  <p>Channel authority: not granted. Native evidence concerns Firm identity and residential management service area, not a verified physical office, phone, calling or email permission.</p>
  {verified?<><p>Current native source evidence, valid until {native.validUntil}.</p><details><summary>Native identity, service area and residential citations</summary>{native.citations.map(citation=>{
   const source=view.observations.find(s=>s.id===citation.observationId),block=source?.blocks.find(b=>b.id===citation.blockId);
   return source&&block?<div key={`${citation.kind}:${citation.observationId}:${citation.blockId}`}><p>{citation.kind.replaceAll('_',' ')} · run {native.runId} · block {citation.blockId}</p><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a><blockquote>{block.text}</blockquote></div>:null;
  })}</details></>:null}
  <Button variant="quiet" disabled={!online} onClick={()=>{setValue(null);setRefresh(n=>n+1);}}>Refresh current Firm evidence</Button>
  {view?<QualificationPanel candidateId={view.candidateId} revision={view.candidateRevision} enabled={enabled}/>:null}
 </section>;
}
