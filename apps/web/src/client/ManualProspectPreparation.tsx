import {useState,type JSX} from 'react';
import type {ManualProspect} from '@fss/contracts';
import {manualProspectLabel} from './manualProspectPresentation.ts';

/** A manual scratchpad, never a conversation, recipient resolver or outbound command. */
export function ManualProspectPreparation({prospect,isScopeCurrent,openActivity}:{prospect:ManualProspect;isScopeCurrent:()=>boolean;openActivity:()=>void}):JSX.Element{
 const [draft,setDraft]=useState(''),[reviewed,setReviewed]=useState<string|null>(null);
 return <section aria-label="Manual NO SEND preparation" className="rounded-md border p-4">
  <h4>Manual preparation for {manualProspectLabel(prospect)}</h4>
  <p>Exact candidate {prospect.candidateId} · revision {prospect.revision}. UNVERIFIED · Contact authority not granted.</p>
  <p>NO SEND · Manual text, not generated. Recipient and channel unknown. This observation is not an associated Firm or conversation. Original-backed Replies is separate.</p>
  <label>Manual outreach draft<textarea aria-label="Manual outreach draft" autoFocus rows={6} maxLength={10000} value={draft} onChange={event=>{if(!isScopeCurrent())return;setDraft(event.target.value);setReviewed(null);}}/></label>
  <p>Draft and review live only in this open view. Reload, selection, refresh or access changes discard them. Nothing is saved or sent.</p>
  <button type="button" disabled={!draft.trim()} onClick={()=>{if(isScopeCurrent())setReviewed(draft);}}>Review exact draft · NO SEND</button>
  {reviewed!==null?<article aria-label="Reviewed manual draft"><h5>Exact manual draft · NO SEND</h5><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{reviewed}</p><p>Human review only. No send, attempt, consent or outcome was recorded.</p></article>:<p role="status">No current exact-text review. Editing invalidates review.</p>}
  <button type="button" onClick={()=>{if(isScopeCurrent())openActivity();}}>Open this prospect's private manual activity</button>
  <p>Activity is a separate explicit user report of a manual phone attempt, not the result of reviewing this draft. Opening activity records nothing.</p>
  <p>To find a reported callback intention again: select this exact prospect, open private manual activity, choose Refresh manual activity, then deliberately open the exact report. Review its note and callback time, which may be unknown. Reports may span pages. This is not an earliest-due queue, reminder, Today task, booking or action.</p>
 </section>;
}
