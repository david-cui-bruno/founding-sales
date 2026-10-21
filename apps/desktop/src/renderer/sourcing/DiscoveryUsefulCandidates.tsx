import {useEffect,useRef,useState,type JSX} from 'react';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {operations} from '../app/bridges.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {Button} from '../ui/button.tsx';
import {DiscoveryReviewForm,type SaveDiscoveryReview} from './DiscoveryReviewForm.tsx';
export type UsefulDiscoveryList=(input:OperationInput<'sourcing.discoveryUsefulList'>)=>Promise<OperationOutput<'sourcing.discoveryUsefulList'>>;
export const usefulDiscoveryList:UsefulDiscoveryList=async input=>operations()?.read('sourcing.discoveryUsefulList',input)??{view:null,reason:'unavailable'};
export const saveDiscoveryReview:SaveDiscoveryReview=async input=>operations()?.command('sourcing.discoveryReview',input)??{result:null,reason:'unavailable'};
const bands={review_first:'Review first',tentative:'Tentative',unreviewed:'Unreviewed',contradicted:'Contradictory evidence'} as const;
const statuses={needs_review:'Needs review',kept:'Kept',dismissed:'Dismissed'} as const;

export function DiscoveryUsefulCandidates({list=usefulDiscoveryList,save=saveDiscoveryReview,enabled=true,privacyKey=''}:{list?:UsefulDiscoveryList;save?:SaveDiscoveryReview;enabled?:boolean;privacyKey?:string}):JSX.Element {
  const epoch=useSessionEpoch();
  return <UsefulPage key={privacyKey} epoch={epoch} list={list} save={save} enabled={enabled}/>;
}
function UsefulPage({list,save,enabled,epoch}:{list:UsefulDiscoveryList;save:SaveDiscoveryReview;enabled:boolean;epoch:object|null}):JSX.Element {
  const [filter,setFilter]=useState<OperationInput<'sourcing.discoveryUsefulList'>>({status:'needs_review',offset:0});
  const [answer,setAnswer]=useState<{value:OperationOutput<'sourcing.discoveryUsefulList'>;epoch:object|null}|null>(null);
  const [loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0),[editing,setEditing]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const sequence=useRef(0),currentEpoch=useRef(epoch);currentEpoch.current=epoch;
  useEffect(()=>{
    let active=true;const request=++sequence.current;
    setAnswer(null);setEditing(null);setNotice(null);
    if(!enabled){setLoading(false);return;}
    setLoading(true);
    void list(filter).then(value=>{if(active&&request===sequence.current&&currentEpoch.current===epoch)setAnswer({value,epoch});})
      .catch(()=>{if(active&&request===sequence.current&&currentEpoch.current===epoch)setAnswer({value:{view:null,reason:'unavailable'},epoch});})
      .finally(()=>{if(active&&request===sequence.current&&currentEpoch.current===epoch)setLoading(false);});
    return()=>{active=false;};
  },[list,filter,refresh,enabled,epoch]);
  const view=enabled&&answer?.epoch===epoch?answer.value.view:null;
  const change=(value:OperationInput<'sourcing.discoveryUsefulList'>)=>{setAnswer(null);setEditing(null);setFilter(value);};
  return <section aria-label="Useful discovery queue" className="space-y-3 rounded-lg border border-border p-4">
    <h2 className="text-lg font-medium">Useful discovery queue</h2>
    <p>Human-reviewed service signals, not independently verified firms. Descriptive paragraphs can be review first even with identity unknown. Headings are tentative, ambiguous website association caps priority. Missing, expired or inaccessible evidence stays unknown, never dismissed.</p>
    <p>Firm identity, first-party completeness, legal clearance and qualification remain unresolved. No admission, runtime calling or contact authority. Reads and Refresh do not fetch sources, run models or create CRM records.</p>
    <div className="flex flex-wrap gap-2"><label>Status<select aria-label="Useful status" disabled={!enabled||loading} value={filter.status} onChange={event=>change({...filter,status:event.target.value as typeof filter.status,offset:0})}>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>Priority<select aria-label="Useful priority" disabled={!enabled||loading} value={filter.band??'all'} onChange={event=>change(event.target.value==='all'?{status:filter.status,offset:0}:{status:filter.status,offset:0,band:event.target.value as keyof typeof bands})}><option value="all">All priorities</option>{Object.entries(bands).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <Button variant="quiet" disabled={!enabled||loading} onClick={()=>{setAnswer(null);setEditing(null);setRefresh(value=>value+1);}}>Refresh useful queue</Button>
    </div>
    {!enabled?<p role="status">Useful discovery is unavailable while this view is disabled.</p>:loading?<p role="status">Loading useful discovery…</p>:answer?.epoch===epoch&&answer.value.view===null?<p role="alert">Useful discovery could not load or was refused. Nothing was cleared. Retry Refresh useful queue.</p>:null}
    {notice?<p role="status">{notice}</p>:null}
    {view?<><ul className="divide-y divide-border">{view.candidates.map(({candidate,review,band})=><li key={candidate.id} className="space-y-2 break-words py-3 text-sm">
      <h3 className="font-medium">{candidate.payload.row.firmName}</h3><p>Human priority: {bands[band]} · Status: {statuses[candidate.status]} · Revision: {candidate.revision}</p>
      <p>Website (unverified text): {candidate.payload.row.website??'Unknown'}</p>
      <p>Firm identity: not independently verified. Office support unknown. Not qualified or admitted.</p>
      {review?<><p>Human service interpretation: {review.assessment.serviceSignal} · Website association (human): {review.assessment.websiteAssociation} · Reviewed: {review.reviewedAt}</p>
        <p>Unresolved questions: {review.assessment.unknowns.join(', ')||'No reviewer questions recorded. Independent identity, completeness and clearance still unresolved.'}</p>
        {review.evidence.map((page,index)=><div key={index}><p>Retained excerpt source (unverified text): {page.url} · Retrieved: {page.retrievedAt} · Completeness: {page.completeness}, not independent first-party verification</p>{page.blocks.map(block=><p key={block.blockId}>{block.kind} [{block.blockId}]: {block.text}</p>)}</div>)}</>:<p>No current review. Missing, stale, changed or inaccessible evidence leaves service and website association unknown. Review an existing minimized excerpt explicitly, without fetching.</p>}
      {candidate.status!=='dismissed'?editing===candidate.id?<DiscoveryReviewForm key={`${candidate.id}:${candidate.revision}`} candidate={candidate} save={save} onCancel={()=>setEditing(null)} onSaved={()=>{if(currentEpoch.current===epoch){setAnswer(null);setEditing(null);setNotice('Human interpretation saved. Refreshing current priority.');setRefresh(value=>value+1);}}}/>:<Button size="sm" variant="outline" onClick={()=>setEditing(candidate.id)}>Review service signal for {candidate.payload.row.firmName}</Button>:null}
    </li>)}</ul>{view.candidates.length===0?<p>No discovery candidates in this priority and status. An empty useful queue is not evidence of rejection or verified coverage.</p>:null}
      <div className="flex gap-2"><Button variant="quiet" disabled={loading||filter.offset===0} onClick={()=>change({...filter,offset:Math.max(0,filter.offset-50)})}>Previous useful page</Button><Button variant="quiet" disabled={loading||!view.hasMore||filter.offset>=1000000} onClick={()=>change({...filter,offset:filter.offset+50})}>Next useful page</Button></div>
    </>:null}
  </section>;
}
