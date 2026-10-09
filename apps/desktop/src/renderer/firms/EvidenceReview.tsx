import { useCallback, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { z } from 'zod';
import type { CanonicalSourceReference, CrmEvidencePage, crmEvidenceReadSchema } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
export interface EvidenceReviewPorts {
 read(input:z.infer<typeof crmEvidenceReadSchema>):Promise<CrmEvidencePage>;
}
export function EvidenceReview({sources,ports,enabled,recordId,privacyKey,sourceVersion}:{sources:readonly CanonicalSourceReference[];ports:EvidenceReviewPorts;enabled:boolean;recordId:string;privacyKey:string;sourceVersion?:string|undefined}):JSX.Element {
 const [page,setPage]=useState<CrmEvidencePage|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const sourceIdentity=JSON.stringify(sources.map(source=>[source.workspaceId,source.sourceId,source.kind,source.revision,source.contentHash,source.availability]));
 const epoch=useRef(0);
 const invalidate=useCallback(()=>++epoch.current,[]);
 useLayoutEffect(()=>{invalidate();setPage(null);setError('');setBusy(false);return()=>{invalidate();};},[ports,enabled,recordId,privacyKey,sourceVersion,sourceIdentity,invalidate]);
 const read=async(source:CanonicalSourceReference)=>{
  const ticket=invalidate();setPage(null);setBusy(true);setError('');
  try{
   const value=await ports.read({source:{workspaceId:source.workspaceId,sourceId:source.sourceId,kind:source.kind,revision:source.revision,contentHash:source.contentHash,locator:null},limit:50});
   if(ticket!==epoch.current)return;
   if(value.source.workspaceId!==source.workspaceId||value.source.sourceId!==source.sourceId||value.source.kind!==source.kind||value.source.revision!==source.revision||value.source.contentHash!==source.contentHash)throw new Error('source_changed');
   setPage(value);
  }catch{if(ticket===epoch.current){setPage(null);setError('Evidence is unavailable. Refresh the source and check current access.');}}
  finally{if(ticket===epoch.current)setBusy(false);}
 };
 const supported=(claim:CrmEvidencePage['claims'][number])=>page!==null&&claim.source.availability==='available'&&claim.source.workspaceId===page.source.workspaceId&&claim.source.sourceId===page.source.sourceId&&claim.source.kind===page.source.kind&&claim.source.revision===page.source.revision&&claim.source.contentHash===page.source.contentHash;
 const interpretation=(claim:CrmEvidencePage['claims'][number],historical:boolean)=><article key={`${historical?'history':'current'}:${claim.claimId}`}>
  {historical?<p>Previously reviewed interpretation</p>:null}
  <p>AI interpretation · {claim.status} · {claim.effectiveState}</p>
  <p>{claim.interpretation}</p>
  <blockquote>{claim.quote}</blockquote>
  <p>Source revision {claim.source.revision} · {claim.source.locator??'Passage location unavailable'} · {claim.source.speaker??'Speaker unknown'}</p>
  {claim.reviewRequired?<p>Material evidence changed. Human review is required.</p>:null}
  {claim.decision?<div><p>Human {claim.decision.action} · {claim.decision.decisionAt}</p>{claim.decision.correctedInterpretation?<p>Human correction: {claim.decision.correctedInterpretation}</p>:null}{claim.decision.rationale?<p>{claim.decision.rationale}</p>:null}</div>:null}
  {claim.decisionHistoryTruncated?<p>More dated decisions exist.</p>:null}
 </article>;
 return <section aria-label="Evidence review">
  <h4>Evidence review</h4>
  <p>AI interpretations are proposals. Human review preserves original evidence and dated decisions.</p>
  {enabled?<>
   {error?<p role="alert">{error}</p>:null}
   {sources.map((source,index)=><Button key={source.sourceId} disabled={busy||source.availability!=='available'||source.contentHash===null} onClick={()=>void read(source)}>Review evidence {index+1}</Button>)}
   {page?<section aria-label="Selected source interpretations">
    <p>{page.source.occurredAt===null?'Original event date unknown':`Original event date: ${page.source.occurredAt}`}</p>
    <p>Source observed: {page.source.observedAt}</p>
    <p>This source page: {page.projection.counts.current} current interpretations, {page.projection.counts.reviewedHistory} previously reviewed interpretations.</p>
    {page.projection.truncated?<p>More evidence exists beyond this bounded page.</p>:null}
    {page.claims.length===0?<p>No current interpretations on this page.</p>:null}
    {page.claims.filter(supported).map(claim=>interpretation(claim,false))}
    {page.reviewedHistory.filter(supported).map(claim=>interpretation(claim,true))}
   </section>:null}
  </>:<p>Evidence unavailable.</p>}
 </section>;
}
