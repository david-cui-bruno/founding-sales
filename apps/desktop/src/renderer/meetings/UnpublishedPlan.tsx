import type { JSX } from 'react';
import { saveMeetingUnpublishedPlanSchema, type MeetingFollowThroughViewV2, type SaveMeetingUnpublishedPlan } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { noDefiniteAnswer } from '../today/afterCallModel.ts';
import { unpublishedForm, useUnpublishedPlanMemory } from './unpublishedPlanMemory.ts';
export type UnpublishedSave = (input: SaveMeetingUnpublishedPlan & {commandId:string}) => Promise<{view:MeetingFollowThroughViewV2|null;reason:string|null}>;
const defaultSave: UnpublishedSave = async input => await globalThis.callieApi?.command('meetings.saveUnpublishedPlan',input) ?? {view:null,reason:'offline'};
export function UnpublishedPlan({view,onSaved,save=defaultSave,actionsEnabled=true}:{view:MeetingFollowThroughViewV2;onSaved:(view:MeetingFollowThroughViewV2)=>void;save?:UnpublishedSave;actionsEnabled?:boolean}):JSX.Element {
  const {entry,touch,stale,rebase}=useUnpublishedPlanMemory(view);
  const terminal=['cancelled','completed'].includes(view.status);
  const disabled=entry.busy||entry.pending!==null||!actionsEnabled||terminal;
  const submit=async()=>{
    if(entry.busy||!actionsEnabled||terminal||(stale&&entry.pending===null))return;
    if(entry.pending===null){
      const parsed=saveMeetingUnpublishedPlanSchema.safeParse(entry.form);
      if(!parsed.success){entry.message='Use a single-line subject up to 998 characters and plain-text messages up to 4,000 characters.';touch();return;}
      entry.pending={...parsed.data,commandId:crypto.randomUUID()};
    }
    entry.busy=true;entry.message=null;touch();
    try{
      const answer=await save(entry.pending);
      if(answer.view?.meetingId===view.meetingId){entry.form=unpublishedForm(answer.view);entry.pending=null;entry.dirty=false;entry.message='Four unpublished drafts saved. All remain held. Nothing was scheduled or sent.';onSaved(answer.view);}
      else if(noDefiniteAnswer(answer.reason))entry.message='The answer was lost. Retry uses the same request. Your text is kept.';
      else {entry.pending=null;entry.message=answer.reason==='source_changed'?'Meeting notes changed. Your text is kept. Review the current notes before saving again.':answer.reason==='draft_changed'?'The saved plan changed. Your text is kept. Refresh and compare before saving again.':'This save could not finish. Your text is kept.';}
    }catch{entry.message='The answer was lost. Retry uses the same request. Your text is kept.';}
    finally{entry.busy=false;touch();}
  };
  return <section aria-label="Unpublished demo drafts" className="space-y-3 border-t border-border pt-3">
    <h5 className="text-sm font-medium">Unpublished demo follow-through</h5>
    <p className="text-sm text-muted-foreground">Recap, then elapsed days 3, 7 and 14. Enter only known actual notes. Leave unknown details blank or in braces for human entry. Saving never publishes, enrolls, schedules or sends these drafts.</p>
    <p className="text-xs text-muted-foreground">Existing reply, refusal, booking and cancellation stops remain unchanged. Existing enrolled schedules are not changed.</p>
    {view.unpublishedPlan!=null?<p className="text-xs">Saved revision {view.unpublishedPlan.revision}. All four drafts held.</p>:null}
    {entry.form.messages.map((message,index)=><fieldset key={index} className="space-y-2" disabled={disabled}>
      <legend className="text-sm">{index===0?'Recap draft':`Day ${[0,3,7,14][index]} draft`}</legend>
      <label className="block text-sm">Subject<Input aria-label={`Draft ${index+1} subject`} maxLength={998} value={message.subject} onChange={event=>{message.subject=event.target.value;entry.dirty=true;touch();}}/></label>
      <label className="block text-sm">Message<Textarea aria-label={`Draft ${index+1} message`} rows={3} maxLength={4000} value={message.body} onChange={event=>{message.body=event.target.value;entry.dirty=true;touch();}}/></label>
      {view.unpublishedPlan?.messages[index]?.unknownFields.length?<p className="text-xs">Needs human entry: {view.unpublishedPlan.messages[index]!.unknownFields.join(', ')}</p>:null}
    </fieldset>)}
    {stale&&entry.pending===null?<><p role="status">Current notes or the saved plan changed. Refresh and review the current notes, then explicitly keep and rebase your typed drafts.</p><Button size="sm" disabled={entry.busy||!actionsEnabled||terminal||view.draftSource==null} onClick={()=>{rebase();touch();}}>I reviewed current notes. Keep text and rebase drafts</Button></>:null}
    <Button size="sm" disabled={disabled||stale} onClick={()=>{void submit();}}>Save unpublished drafts</Button>
    {entry.pending!==null&&!entry.busy?<Button size="sm" disabled={!actionsEnabled||terminal} onClick={()=>{void submit();}}>Retry draft save</Button>:null}
    {entry.message!==null?<p role="status" className="text-sm">{entry.message}</p>:null}
  </section>;
}
