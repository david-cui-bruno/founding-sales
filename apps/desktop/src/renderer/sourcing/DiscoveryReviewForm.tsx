import {useEffect,useRef,useState,type JSX} from 'react';
import {discoveryReviewInputSchema,type DiscoveryReviewInput} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../../shared/operations.ts';
import {Button} from '../ui/button.tsx';
import {Input} from '../ui/input.tsx';
export type UsefulCandidate=NonNullable<OperationOutput<'sourcing.discoveryUsefulList'>['view']>['candidates'][number]['candidate'];
export type SaveDiscoveryReview=(input:OperationInput<'sourcing.discoveryReview'>)=>Promise<OperationOutput<'sourcing.discoveryReview'>>;
const unknownDefaults='firm_identity_unknown\nfirst_party_completeness_unknown\nlegal_clearance_unknown\nfit_not_qualified';

/** One minimized retained page/block per explicit review, not a body/contact import.
 * Candidate provenance is selected, never fabricated from a website URL. */
export function DiscoveryReviewForm({candidate,save,onSaved,onCancel}:{candidate:UsefulCandidate;save:SaveDiscoveryReview;onSaved():void;onCancel():void}):JSX.Element {
  const [hasExcerpt,setHasExcerpt]=useState(false),[origin,setOrigin]=useState('0');
  const [url,setUrl]=useState(''),[hash,setHash]=useState(''),[retrieved,setRetrieved]=useState(''),[blockId,setBlockId]=useState(''),[text,setText]=useState('');
  const [kind,setKind]=useState<'paragraph'|'heading'|'unknown'>('unknown');
  const [signal,setSignal]=useState<DiscoveryReviewInput['assessment']['serviceSignal']>('unknown');
  const [association,setAssociation]=useState<DiscoveryReviewInput['assessment']['websiteAssociation']>('unknown');
  const [unknowns,setUnknowns]=useState(unknownDefaults),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
  const active=useRef(true),pending=useRef<{serialized:string;commandId:string}|null>(null);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const submit=async()=>{
    if(busy||!confirmed)return;
    const source=candidate.origins[Number(origin)]?.source;
    const input=discoveryReviewInputSchema.safeParse({candidateId:candidate.id,expectedRevision:candidate.revision,reviewVersion:'discovery-review-v1',
      evidence:hasExcerpt&&source?[{source:{provider:source.provider,release:source.release,recordId:source.recordId},url,contentHash:hash,retrievedAt:retrieved,completeness:'unknown',association,basis:'retained_excerpt',blocks:[{blockId,kind,text}]}]:[],
      assessment:{serviceSignal:signal,websiteAssociation:association,unknowns:unknowns.split('\n').map(value=>value.trim()).filter(Boolean)}});
    if(!input.success){setMessage('Review is incomplete or exceeds bounds. Supply an original URL, SHA-256 hash, ISO retrieval time, block identity and excerpt. A heading cannot support a paragraph signal.');return;}
    const serialized=JSON.stringify(input.data);
    if(pending.current?.serialized!==serialized)pending.current={serialized,commandId:crypto.randomUUID()};
    setBusy(true);setMessage(null);
    try{
      const answer=await save({...input.data,commandId:pending.current.commandId});
      if(!active.current)return;
      if(answer.result){pending.current=null;onSaved();}
      else setMessage(`Review not confirmed saved (${answer.reason??'unknown'}). Retry the same content to reconcile an uncertain save, or refresh to review the current revision.`);
    }catch{if(active.current)setMessage('Save outcome unknown. Retry the same review to reconcile it. No source was fetched.');}
    finally{if(active.current)setBusy(false);}
  };
  return <form aria-label={`Human review for ${candidate.payload.row.firmName}`} className="space-y-3 rounded border p-3" onSubmit={event=>{event.preventDefault();void submit();}}>
    <p>Human interpretation, not independently verified fact. Revision {candidate.revision}. Only minimized public-business service excerpts. Do not paste private CRM notes, message bodies, personal details or contact inventories. No source will be fetched.</p>
    <label className="block"><input type="checkbox" checked={hasExcerpt} disabled={busy} onChange={event=>{setHasExcerpt(event.target.checked);setConfirmed(false);}}/> Include one retained excerpt</label>
    {hasExcerpt?<fieldset disabled={busy} className="space-y-2"><legend>Original retained excerpt provenance, not proof of website ownership</legend>
      <label className="block">Existing origin<select aria-label="Existing origin" value={origin} onChange={event=>setOrigin(event.target.value)}>{candidate.origins.map((item,index)=><option key={index} value={index}>{item.source.provider} / {item.source.release} / {item.source.recordId}</option>)}</select></label>
      <label className="block">Original page URL<Input aria-label="Original page URL" value={url} maxLength={500} onChange={event=>setUrl(event.target.value)}/></label>
      <label className="block">Original content SHA-256<Input aria-label="Original content SHA-256" value={hash} maxLength={64} onChange={event=>setHash(event.target.value)}/></label>
      <label className="block">Original retrieved-at ISO timestamp<Input aria-label="Original retrieved-at ISO timestamp" placeholder="YYYY-MM-DDTHH:mm:ss.sssZ" value={retrieved} maxLength={40} onChange={event=>setRetrieved(event.target.value)}/></label>
      <label className="block">Original block ID<Input aria-label="Original block ID" value={blockId} maxLength={80} onChange={event=>setBlockId(event.target.value)}/></label>
      <label className="block">Block kind<select aria-label="Block kind" value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="unknown">Unknown</option><option value="paragraph">Descriptive paragraph</option><option value="heading">Heading only</option></select></label>
      <label className="block">Minimized public-business excerpt<textarea aria-label="Minimized public-business excerpt" value={text} maxLength={2000} onChange={event=>setText(event.target.value)}/></label>
    </fieldset>:<p>No retained excerpt: service remains unknown and unreviewed, never rejected.</p>}
    <label className="block">Human service interpretation<select aria-label="Human service interpretation" disabled={busy} value={signal} onChange={event=>setSignal(event.target.value as typeof signal)}><option value="unknown">Unknown</option><option value="paragraph_supported">Supported by descriptive paragraph</option><option value="tentative">Tentative, including heading only</option><option value="contradicted">Contradictory evidence, not dismissal</option></select></label>
    <label className="block">Human website association<select aria-label="Human website association" disabled={busy} value={association} onChange={event=>setAssociation(event.target.value as typeof association)}><option value="unknown">Unknown</option><option value="supported">Supported human interpretation, not verified identity</option><option value="ambiguous">Ambiguous, priority capped tentative</option></select></label>
    <label className="block">Unresolved questions, one per line<textarea aria-label="Unresolved questions" value={unknowns} disabled={busy} maxLength={3600} onChange={event=>setUnknowns(event.target.value)}/></label>
    <label className="block"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/> I reviewed the minimized public-business content and original provenance. This does not establish firm identity, completeness, legal clearance, qualification or contact authority.</label>
    {message?<p role="alert">{message}</p>:null}
    <Button type="submit" disabled={busy||!confirmed}>{busy?'Saving human review…':'Save human interpretation'}</Button><Button type="button" variant="quiet" disabled={busy} onClick={onCancel}>Cancel human review</Button>
  </form>;
}
