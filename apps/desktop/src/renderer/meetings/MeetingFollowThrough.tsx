import { useCallback,useEffect,useRef,type JSX } from 'react';
import { meetingDraftEditSchema,type MeetingDraftEdit,type MeetingFollowThroughView } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { noDefiniteAnswer } from '../today/afterCallModel.ts';
import { useFollowThroughMemory } from './followThroughMemory.ts';
export interface FollowThroughPorts {
  read(meetingId:string):Promise<{view:MeetingFollowThroughView|null;reason:string|null}>;
  edit(input:MeetingDraftEdit&{commandId:string}):Promise<{view:MeetingFollowThroughView|null;reason:string|null}>;
}
const defaultPorts:FollowThroughPorts={
  read:async meetingId=>await globalThis.callieApi?.read('meetings.followThrough',{meetingId})??{view:null,reason:'unavailable'},
  edit:async input=>await globalThis.callieApi?.command('meetings.editRecap',input)??{view:null,reason:'offline'},
};
const reasons:Record<string,string>={
  recap_stale:'This meeting was more than two business days ago. Review and save the recap before sending.',
  source_changed:'Meeting notes changed. Check Notes & tasks before updating this draft.',
  notes_incomplete:'Add or confirm sufficient notes in Notes & tasks.',attendance_unconfirmed:'Confirm that the prospect attended this meeting.',
  recipient_unresolved:'Confirm the prospect contact on this meeting.',recipient_changed:'The meeting contact changed. Review the intended recipient.',
  recap_template_required:'Choose an approved recap sequence in Settings → Calling & calendar.',recap_sequence_required:'Choose a published recap sequence with one to three email steps.',
  template_unapproved:'The selected email template needs approval.',nudge_template_required:'Choose an approved follow-up template without the recap placeholder.',
  unsupported_commitment:'A promise in the notes needs your review before this message can send.',material_unavailable:'A promised material is missing. Check Notes & tasks.',
  scope_needs_review:'The prospect’s follow-up request needs your review.',reminder_outside_scope:'The agreed date needs a separately recorded follow-up permission.',
  manual_email_review:'You sent an email in Gmail. Review it before sending another recap.',reply_received:'A reply arrived. Review it in Replies.',
  new_meeting:'A newer meeting replaced this follow-up.',opportunity_required:'Select an open deal for this meeting.',opportunity_manual:'You are handling this conversation yourself.',
  firm_already_enrolled:'Another outreach contact is active at this firm.',not_assigned:'This firm’s owner changed.',suppressed:'A contact stop is in place.',
  enrollment_stopped:'Follow-up was stopped.',delivery_bytes_unverified:'Check the restored sent message before continuing.',time_zone_unresolved:'Confirm the firm’s time zone.',
  follow_up_expired:'The follow-up permission expired.',source_incomplete:'Review the incomplete meeting notes.',
};
export function MeetingFollowThrough({meetingId,ports=defaultPorts,actionsEnabled=true}:{meetingId:string;ports?:FollowThroughPorts;actionsEnabled?:boolean}):JSX.Element {
  const {entry,touch}=useFollowThroughMemory(meetingId),portsRef=useRef(ports);portsRef.current=ports;
  const load=useCallback(async()=>{
    const generation=++entry.generation;entry.loading=true;touch();
    try {
      const answer=await portsRef.current.read(meetingId);if(generation!==entry.generation)return;
      if(answer.view?.meetingId===meetingId){if(entry.view===null||answer.view.planId!==entry.view.planId||answer.view.version>=entry.view.version)entry.view=answer.view;entry.unavailable=false;entry.gone=false;}
      else {entry.unavailable=true;if(answer.reason==='not_found'){entry.view=null;entry.form=null;entry.pending=null;entry.editingUi=false;entry.gone=true;}}
    } catch {if(generation===entry.generation)entry.unavailable=true;}
    finally {if(generation===entry.generation){entry.loading=false;touch();}}
  },[entry,meetingId,touch]);
  useEffect(()=>{if(entry.open)void load();},[entry.open,load]);
  const command=async(action:MeetingDraftEdit['action'])=>{
    const view=entry.view,draft=view?.currentDraft;if(entry.busy||!actionsEnabled||view?.planId==null||draft==null)return;
    if(entry.pending===null){
      const base={planId:view.planId,expectedPlanVersion:view.version,expectedDraftVersion:draft.version};
      const parsed=meetingDraftEditSchema.safeParse(action==='save'&&entry.form!==null?{...entry.form,action}:{...base,action});
      if(!parsed.success){entry.message='Enter a subject and a plain-text message of up to 4,000 characters.';touch();return;}
      entry.pending={...parsed.data,commandId:crypto.randomUUID()};
    }
    const pending=entry.pending;entry.busy=true;entry.message=null;++entry.generation;touch();
    try {
      const answer=await portsRef.current.edit(pending);
      if(answer.view?.meetingId===meetingId){
        entry.view=answer.view;entry.pending=null;entry.unavailable=false;
        if(pending.action==='begin_edit'&&answer.view.currentDraft!==null){
          const current=answer.view.currentDraft;
          entry.form={planId:answer.view.planId!,expectedPlanVersion:answer.view.version,expectedDraftVersion:current.version,subject:entry.form?.subject??current.subject,body:entry.form?.body??current.body};entry.editingUi=true;
        } else {entry.form=null;entry.editingUi=false;entry.message=pending.action==='save'?'Recap saved.':pending.action==='cancel'?'Follow-up cancelled.':null;}
      } else if(noDefiniteAnswer(answer.reason))entry.message='The answer was lost. Retry uses the same request.';
      else if(answer.reason==='not_found'){entry.view=null;entry.form=null;entry.pending=null;entry.editingUi=false;entry.gone=true;entry.unavailable=true;}
      else {entry.pending=null;entry.message=['draft_changed','source_changed'].includes(answer.reason??'')?'The meeting or draft changed. Your draft is kept. Refresh to compare.':'This action could not finish. Your draft is kept.';}
    } catch {entry.message='The answer was lost. Retry uses the same request.';}
    finally {entry.busy=false;entry.loading=false;touch();}
  };
  const view=entry.view,draft=view?.currentDraft,form=entry.form;
  const terminal=view?.status==='cancelled'||view?.status==='completed',immutable=draft?.state==='submitted'||draft?.state==='sent';
  const disabled=entry.busy||entry.pending!==null||entry.gone||!actionsEnabled;
  return <div className="min-w-0" data-testid="meeting-follow-through">
    <Button size="sm" variant="quiet" aria-expanded={entry.open} onClick={()=>{entry.open=!entry.open;touch();}}>Follow-up</Button>
    {entry.open?<section aria-label="Meeting follow-up" className="mt-2 space-y-4 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{draft?.ordinal!==undefined&&draft.ordinal>1?'Follow-up message':'Meeting recap'}</h4><Button size="sm" variant="quiet" disabled={entry.busy||entry.loading} onClick={()=>{void load();}}>Refresh follow-up</Button></div>
      {entry.unavailable?<p role="status" className="text-sm text-muted-foreground">{entry.gone?'This follow-up is no longer available.':'Callie could not load the latest follow-up. Try Refresh follow-up.'}</p>:null}
      {view===null?entry.loading?<p className="text-sm text-muted-foreground">Reading follow-up…</p>:null:<>
        <p className="text-sm text-muted-foreground">{draft?.state==='submitted'?'Delivery in progress':draft?.state==='sent'?'Recap sent':terminal?view.status==='cancelled'?'Follow-up cancelled':'Follow-up complete':view.sendingPaused?'Sending paused':draft?.state==='editing'?'Paused while you edit':view.blockers.length>0?'Needs your review':draft==null?'No recap prepared yet':`Ready after ${new Date(draft.notBefore).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`}</p>
        {[...new Set(view.blockers.filter(r=>!['sending_paused','editing'].includes(r)).map(r=>reasons[r]??'Review this follow-up before sending.'))].map(text=><p key={text} className="text-sm text-muted-foreground">{text}</p>)}
        {draft==null?<p className="text-sm text-muted-foreground">Add sufficient notes in Notes & tasks and choose an approved recap sequence in Calling & calendar. Callie prepares the draft when those are ready.</p>:entry.editingUi&&form!==null?<div className="space-y-3">
          <label className="block space-y-1 text-sm"><span>Subject</span><Input aria-label="Recap subject" maxLength={998} value={form.subject} disabled={entry.busy||!actionsEnabled} onChange={e=>{entry.form={...form,subject:e.target.value};touch();}}/></label>
          <label className="block space-y-1 text-sm"><span>Message</span><Textarea aria-label="Recap message" rows={8} maxLength={4000} value={form.body} disabled={entry.busy||!actionsEnabled} onChange={e=>{entry.form={...form,body:e.target.value};touch();}}/></label>
          <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled||immutable||terminal} onClick={()=>{void command('save');}}>Save recap</Button><Button size="sm" variant="quiet" disabled={disabled||immutable||terminal} onClick={()=>{void command('discard');}}>Discard edits</Button></div>
        </div>:<div className="space-y-3"><p className="text-sm font-medium break-words">{draft.subject}</p><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{draft.body}</p></div>}
        {draft!=null&&!immutable&&!terminal?<div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled} aria-expanded={entry.editingUi} onClick={()=>{if(entry.editingUi){entry.editingUi=false;touch();}else void command('begin_edit');}}>{entry.editingUi?'Hide editor':draft.state==='editing'?'Resume editing':'Edit recap'}</Button><Button size="sm" variant="quiet" disabled={disabled} onClick={()=>{void command('cancel');}}>Cancel follow-up</Button></div>:null}
        {draft?.state==='submitted'?<p className="text-xs text-muted-foreground">The provider is processing this message. Callie will check the result; it cannot recall an accepted email.</p>:null}
      </>}
      {entry.message!==null?<p role="status" className="text-sm text-muted-foreground">{entry.message}</p>:null}
      {entry.pending!==null&&!entry.busy?<Button size="sm" variant="outline" disabled={!actionsEnabled} onClick={()=>{void command(entry.pending!.action);}}>Retry action</Button>:null}
    </section>:null}
  </div>;
}
