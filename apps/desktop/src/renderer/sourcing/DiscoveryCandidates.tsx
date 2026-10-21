import {useEffect,useRef,useState,type JSX} from 'react';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {operations} from '../app/bridges.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {Button} from '../ui/button.tsx';
export type DiscoveryList=(input:OperationInput<'sourcing.discoveryList'>)=>Promise<OperationOutput<'sourcing.discoveryList'>>;
export const discoveryList:DiscoveryList=async input=>{
  const bridge=operations();if(!bridge)return {view:null,reason:'unavailable'};
  return bridge.read('sourcing.discoveryList',input);
};
const statuses={needs_review:'Needs review',kept:'Kept',dismissed:'Dismissed'} as const;

/** Session-local read state. Source strings are rendered as text, never links or HTML. */
export function DiscoveryCandidates({list=discoveryList,enabled=true,privacyKey='',onObserved}:{list?:DiscoveryList;enabled?:boolean;privacyKey?:string;onObserved?:(()=>void)|undefined}):JSX.Element {
  const epoch=useSessionEpoch();
  // A new owner or generation remounts all state before any old rows can render.
  return <DiscoveryPage key={privacyKey} epoch={epoch} list={list} enabled={enabled} onObserved={onObserved}/>;
}
function DiscoveryPage({list,enabled,epoch,onObserved}:{list:DiscoveryList;enabled:boolean;epoch:object|null;onObserved:(()=>void)|undefined}):JSX.Element {
  const [filter,setFilter]=useState<OperationInput<'sourcing.discoveryList'>>({status:'needs_review',offset:0});
  const [answer,setAnswer]=useState<OperationOutput<'sourcing.discoveryList'>|null>(null);
  const [loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const sequence=useRef(0),currentEpoch=useRef(epoch);currentEpoch.current=epoch;
  const [answerEpoch,setAnswerEpoch]=useState(epoch);
  useEffect(()=>{
    let active=true;const request=++sequence.current;
    if(!enabled)return;
    setLoading(true);setAnswer(null);
    void list(filter).then(result=>{
      if(active&&request===sequence.current&&currentEpoch.current===epoch){setAnswer(result);setAnswerEpoch(epoch);if(result.view===null||result.view.candidates.length>0||result.view.hasMore)onObserved?.();}
    }).catch(()=>{
      if(active&&request===sequence.current&&currentEpoch.current===epoch){setAnswer({view:null,reason:'unavailable'});setAnswerEpoch(epoch);onObserved?.();}
    }).finally(()=>{if(active&&request===sequence.current&&currentEpoch.current===epoch)setLoading(false);});
    return()=>{active=false;};
  },[list,filter,refresh,enabled,epoch,onObserved]);
  const view=enabled&&answerEpoch===epoch?answer?.view:null;
  const change=(status:OperationInput<'sourcing.discoveryList'>['status'],offset=0)=>{setAnswer(null);setFilter({status,offset});};
  return <section aria-label="Raw discovery" className="space-y-3 rounded-lg border border-border p-4">
    <h2 className="text-lg font-medium">Raw discovery</h2>
    <p className="text-sm text-muted-foreground">Retained source observations, not qualified leads. Fit unknown. Office support unknown. No admission, contact or sending authority. Source confidence is not fit.</p>
    <div className="flex flex-wrap gap-2" aria-label="Raw discovery filters">{Object.entries(statuses).map(([status,label])=><Button key={status} size="sm" variant={filter.status===status?'outline':'quiet'} aria-pressed={filter.status===status} disabled={!enabled||loading} onClick={()=>change(status as typeof filter.status)}>Raw: {label}</Button>)}<Button variant="quiet" disabled={!enabled||loading} onClick={()=>setRefresh(value=>value+1)}>Refresh raw discovery</Button></div>
    {!enabled?<p role="status">Raw discovery is unavailable while this view is disabled.</p>:loading?<p role="status">Loading raw discovery…</p>:answer?.view===null?<p role="alert">Raw discovery could not load or was refused. No observations have been cleared. Retry with Refresh raw discovery.</p>:null}
    {view?<><ul className="divide-y divide-border">{view.candidates.map(candidate=>{
      const row=candidate.payload.row;
      return <li key={candidate.id} className="space-y-1 break-words py-3 text-sm"><h3 className="font-medium">{row.firmName}</h3>
        <p>Status: {statuses[candidate.status]}</p><p>Website (unverified text): {row.website??'Unknown'}</p><p>Location (unverified): {row.locality??'Unknown city'}, {row.region??'Unknown state'}</p>
        <p>Provider: {row.source.provider} · Release: {row.source.release}</p><p>Source (unverified text): {row.source.sourceUrl}</p><p>Source record: {row.source.recordId}</p><p>Observed: {row.source.retrievedAt??'Unknown'} · Observations: {row.observations.length}</p>
        <p>Source confidence (not fit): {row.sourceConfidence===null?'Unknown':row.sourceConfidence}</p>
        <p>Residential fit: {row.residentialFit} · Website association: {row.websiteAssociation} · Office phone evidence: {row.officePhoneEvidence}. Not admitted.</p>
      </li>;
    })}</ul>{view.candidates.length===0?<p>No raw discovery observations in this status.</p>:null}
    <div className="flex gap-2"><Button variant="quiet" disabled={loading||filter.offset===0} onClick={()=>change(filter.status,Math.max(0,filter.offset-50))}>Previous raw page</Button><Button variant="quiet" disabled={loading||!view.hasMore||filter.offset>=1000000} onClick={()=>change(filter.status,filter.offset+50)}>Next raw page</Button></div></>:null}
  </section>;
}
