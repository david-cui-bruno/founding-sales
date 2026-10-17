import {useLayoutEffect,useRef,useState} from 'react';
import {linkedinRecurringViewSchema,type LinkedinRecurringView} from '@fss/contracts';
import {operations} from '../app/bridges.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {Button} from '../ui/button.tsx';
export interface LinkedinRecurringPostingPorts{read():Promise<{view:LinkedinRecurringView|null;reason:string|null}>}
const defaults:LinkedinRecurringPostingPorts={read:()=>{const api=operations();if(!api)throw new Error('unavailable');return api.read('social.recurringPosting',{});}};
const labels:Record<LinkedinRecurringView['items'][number]['state'],string>={draft:'Draft preparation',review:'Needs review, no eligible dispatch',skipped:'Skipped, no catch-up',queued:'Queued for existing desktop scheduling',receipt:'Platform receipt recorded',unknown_paused:'Inspect original submission, never replay',revoked:'Revoked: no further eligible dispatch'};
export function LinkedinRecurringPosting({ports=defaults}:{ports?:LinkedinRecurringPostingPorts}){
 const epoch=useSessionEpoch(),live=useRef(0),port=useRef(ports);port.current=ports;
 const [view,setView]=useState<LinkedinRecurringView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const refresh=async()=>{const g=++live.current;setView(null);setBusy(true);setError(null);try{const answer=await port.current.read();if(g!==live.current)return;const parsed=linkedinRecurringViewSchema.safeParse(answer.view);if(parsed.success)setView(parsed.data);else setError('Current recurring state is unavailable. No posting permission changed.');}catch{if(g===live.current)setError('Current recurring state is unavailable. No posting permission changed.');}finally{if(g===live.current)setBusy(false);}};
 useLayoutEffect(()=>{const lifetime=live;void refresh();return()=>{lifetime.current++;};},[epoch]);
 return <section aria-label="Recurring LinkedIn posting" className="space-y-3 rounded-lg border border-border p-4 text-sm">
  <h2 className="font-medium">Recurring LinkedIn posting</h2>
  <p>Personal LinkedIn text only. Tuesday and Thursday at 10AM America/New_York, at most two per week. Unready slots skip, never catch up.</p>
  <p>Saved policy is not Enable or runtime acceptance. Disable or Revoke the existing standing policy in Settings. Existing submitted attempts cannot be unsent and remain inspection-only.</p>
  <Button variant="outline" disabled={busy} onClick={()=>void refresh()}>Refresh recurring posting</Button>
  {error&&<p role="status">{error}</p>}
  {view&&<><ul aria-label="Recurring readiness holds">{view.holds.map(h=><li key={h}>{h.replaceAll('_',' ')}</li>)}</ul>{view.items.length===0?<p>No recurring preparation recorded.</p>:<ol>{view.items.map(item=><li key={item.id} className="space-y-1 border-t py-2"><p>{labels[item.state]}{item.reason?`: ${item.reason.replaceAll('_',' ')}`:''}</p><p>{new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(item.targetAt))} America/New_York. Account {item.accountId}, account revision {item.accountRevision}, policy revision {item.policyRevision}.</p><p>Attributable spend or reserved allowance: ${(item.spendCents/100).toFixed(2)}. {item.approvalKind==='standing_policy'?'Derived standing policy admission, not human per-post approval.':''}</p>{item.receiptId&&<p>Receipt: {item.receiptId}</p>}{item.submissionId&&<p>Submission marker: {item.submissionId}</p>}</li>)}</ol>}</>}
 </section>;
}
