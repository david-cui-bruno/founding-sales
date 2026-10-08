import type {AutomaticEmailLearning} from '@fss/contracts';
import {Button} from '../ui/button.tsx';
import {navigate} from '../routes.ts';
const label=(value:string|null)=>value===null?'Unavailable':value.replaceAll('_',' ');
const reasons:Record<string,string>={mailbox_capacity_exhausted:'Waiting for mailbox allowance',sender_unhealthy:'Sender is on hold',prospect_held:'Prospect is on hold',evaluation_mismatch:'Evaluation does not match the current implementation',candidate_pool_limit:'Candidate pool exceeds the batch limit',enrolled:'Sequence enrolled; sending is reported separately',automatic_email_disabled:'Automatic admission is off'};
export function AutomaticEmailResults({view}:{view:AutomaticEmailLearning}){
 const {control,discovery,outcomes,attention,decisions}=view;
 return <div className="space-y-4" aria-label="Automatic email results">
  <div className="rounded-lg border border-border p-4 space-y-2">
   <h3 className="font-medium">Discovery and automatic email</h3>
   <p>{control?`Automatic email admission is ${control.enabled?'on':'off'}.`:'Admission control status is unavailable for this view.'}</p>
   <p>{discovery.retainedHits} retained discovery hits · {discovery.supportedProspects} currently supported email prospects · {discovery.admissions} discovered candidates admitted</p>
   <p className="text-sm text-muted-foreground">{discovery.manualStaged} manually staged candidates excluded from discovery yield · {discovery.unavailable} discovered candidates with unavailable evidence</p>
   <p>{outcomes.admissions} admissions · {outcomes.attempts} messages attempted · {outcomes.sent} sent · {outcomes.unsettled} with unsettled delivery</p>
   <p>{outcomes.deliveryFailures} delivery failures · {outcomes.optOuts} opt-outs · {outcomes.replies} substantive replies</p>
   <p>{outcomes.booked} bookings · {outcomes.heldQualified} held qualified conversations</p><p className="text-sm text-muted-foreground">{outcomes.unknownQualification} meetings with unknown qualification</p>
   <p className="text-sm text-muted-foreground">Discovery covers this interval. Automatic outcomes follow admissions decided in this interval through the observation date. Sent means durable provider submission; inbox placement and received authentication require separate verification.</p>
   {control?.lastBatchAt?<p className="text-sm">Last batch {new Date(control.lastBatchAt).toLocaleString()} · control revision {control.lastBatchControlRevision} · {control.lastBatchReason?(reasons[control.lastBatchReason]??label(control.lastBatchReason)):'No batch-wide refusal recorded'}</p>:<p className="text-sm text-muted-foreground">No batch observation is available.</p>}
  </div>
  <div className="space-y-2"><h3 className="font-medium">Replies and introductory calls</h3><p className="text-sm text-muted-foreground">Handle substantive replies within one business day. Plan up to three introductory calls each week. Booking and confirmed attendance are separate outcomes.</p><Button variant="outline" onClick={()=>navigate({name:'replies'})}>Open replies</Button>
   {attention.map(f=><div key={f.firmId} className="rounded-lg border border-border p-3"><Button variant="quiet" onClick={()=>navigate({name:'firm',firmId:f.firmId})}>{f.firmName}</Button><p>{f.needsReply} replies needing disposition · {f.bookings} bookings · {f.heldQualified} held qualified conversations</p></div>)}
  </div>
  <div className="space-y-3"><h3 className="font-medium">Automatic admission decisions</h3>
   {!decisions.length?<p className="text-sm text-muted-foreground">No automatic prospect decisions observed in this interval.</p>:null}
   {decisions.map(d=><article key={d.runId} className="rounded-lg border border-border p-4 space-y-2">
    <h4 className="font-medium">{d.firmName}</h4><p>{reasons[d.reason]??label(d.reason)}</p>
    <p className="text-sm">{d.status==='exhausted'?`Rechecks exhausted after ${d.checks} checks`:d.status==='held'?`Held after ${d.checks} checks`:label(d.status)}{d.retryAt?` · next check ${new Date(d.retryAt).toLocaleString()}`:''}</p>
    <p className="text-sm text-muted-foreground">Rank: {label(d.rank)} · decided {new Date(d.decidedAt).toLocaleString()}</p>
    {d.firmId?<Button variant="quiet" onClick={()=>navigate({name:'firm',firmId:d.firmId!})}>Open firm and meetings</Button>:null}
    <details><summary>Evidence and decision binding</summary><div className="mt-2 space-y-2 text-xs break-words">
     <p>Candidate {d.candidateId} · revision {d.candidateRevision} · run {d.runId}</p>
     <p>Policy {label(d.policyVersion)} · prompt {label(d.promptVersion)} · control revision {d.controlRevision}</p>
     <p>Evaluation {d.evaluationSha256??'Unavailable'} · implementation {d.implementationCommit??'Unavailable'} · configuration {d.configurationSha256??'Unavailable'}</p>
     <p>Owner {d.ownerUserId??'Unavailable'} · mailbox {d.mailboxId??'Unavailable'} · sequence {d.sequenceVersionId??'Unavailable'}</p>
     <p>Firm {d.firmId??'None'} · contact {d.contactId??'None'} · route {d.routeId??'None'} · plan {d.planId??'None'} · enrollment {d.enrollmentId??'None'}</p>
     {d.evidence.length?d.evidence.map(e=><p key={e.observationId}><a className="underline" href={e.url} target="_blank" rel="noreferrer">{e.url}</a> · checked {new Date(e.retrievedAt).toLocaleString()} · observation {e.observationId} · blocks {[...new Set(e.blockIds)].join(', ')} · content {e.contentHash}</p>):<p>Source evidence unavailable.</p>}
    </div></details>
   </article>)}
  </div>
 </div>;
}
