import {useCallback,useEffect,useRef,type JSX} from 'react';
import type {MeetingQualificationView,SaveMeetingQualification,QualificationAnswer,QualificationField} from '@fss/contracts';
import {Button} from '../ui/button.tsx';
import {noDefiniteAnswer} from '../today/afterCallModel.ts';
import {outcomeEntry,useOutcomesMemory} from './outcomesMemory.ts';
export interface QualificationPorts {
 read(meetingId:string):Promise<{view:MeetingQualificationView|null;reason:string|null}>;
 save(input:SaveMeetingQualification):Promise<{view:MeetingQualificationView|null;reason:string|null}>;
}
const defaultPorts:QualificationPorts={read:async meetingId=>await globalThis.callieApi?.read('meetings.qualification',{meetingId})??{view:null,reason:'offline'},save:async input=>await globalThis.callieApi?.command('meetings.saveQualification',input)??{view:null,reason:'offline'}};
const fields:readonly [QualificationField,string][]=[['buyingParticipant','Buying participant'],['maintenanceNeed','Real maintenance need'],['openToPaying','Open to paying']];
export interface QualificationMemory {open:boolean;view:MeetingQualificationView|null;draft:Record<QualificationField,QualificationAnswer>|null;revision:number;pending:SaveMeetingQualification|null;busy:boolean;loading:boolean;gone:boolean;message:string|null;generation:number}
export function MeetingQualification({meetingId,ports=defaultPorts,actionsEnabled=true}:{meetingId:string;ports?:QualificationPorts;actionsEnabled?:boolean}):JSX.Element{
 const {memory,touch}=useOutcomesMemory();let existing=memory.qualifications.get(meetingId);
 if(!existing){existing={open:false,view:null,draft:null,revision:0,pending:null,busy:false,loading:false,gone:false,message:null,generation:0};memory.qualifications.set(meetingId,existing);}
 const entry=existing,port=useRef(ports);port.current=ports;
 const load=useCallback(async()=>{
  if(entry.busy)return;const generation=++entry.generation;entry.loading=true;touch();
  try{const result=await port.current.read(meetingId);if(entry.generation!==generation)return;
   if(result.view?.meetingId===meetingId){entry.view=result.view;entry.gone=false;if(!entry.draft){entry.draft={buyingParticipant:result.view.buyingParticipant,maintenanceNeed:result.view.maintenanceNeed,openToPaying:result.view.openToPaying};entry.revision=result.view.revision;}}
   else{entry.message='Could not load qualification.';if(result.reason==='not_found'){entry.gone=true;entry.view=null;entry.draft=null;entry.pending=null;}}
  }catch{if(entry.generation===generation)entry.message='Could not load qualification.';}finally{if(entry.generation===generation){entry.loading=false;touch();}}
 },[entry,meetingId,touch]);
 useEffect(()=>{if(entry.open)void load();},[entry.open,load]);
 const save=async()=>{
  if(entry.busy||!actionsEnabled||entry.gone||!entry.draft)return;
  if(!entry.pending){const commandId=crypto.randomUUID();entry.pending={meetingId,commandId,expectedRevision:entry.revision,...entry.draft,evidence:fields.filter(([f])=>entry.draft![f]!=='unknown').map(([field])=>({field,sourceKind:'user_confirmation',sourceId:commandId,sourceRevision:entry.revision+1}))};}
  const pending=entry.pending;entry.busy=true;entry.message=null;++entry.generation;touch();
  try{const result=await port.current.save(pending);
   if(result.view?.meetingId===meetingId){entry.view=result.view;entry.revision=result.view.revision;entry.pending=null;entry.message='Saved.';}
   else if(noDefiniteAnswer(result.reason))entry.message='Save not confirmed. Retry safely.';
   else{entry.pending=null;entry.message=result.reason==='qualification_changed'?'Qualification changed elsewhere. Your choices are kept. Refresh to compare before saving again.':'Could not save qualification. Your choices are kept.';if(result.reason==='not_found'){entry.gone=true;entry.view=null;entry.draft=null;}}
  }catch{entry.message='Save not confirmed. Retry safely.';}finally{entry.busy=false;entry.loading=false;touch();}
 };
 return <div className="min-w-0"><Button size="sm" variant="quiet" aria-expanded={entry.open} onClick={()=>{entry.open=!entry.open;touch();}}>Demo qualification</Button>{entry.open?<section aria-label="Demo qualification" className="mt-2 space-y-3 rounded-lg border border-border p-4">
  {entry.view?<p className="text-sm font-medium">{entry.view.qualified?'Qualified demo':entry.view.attendanceConfirmed?'Qualification not confirmed':'Attendance not confirmed'}</p>:null}
  {entry.draft?fields.map(([field,label])=><label key={field} className="flex items-center justify-between gap-4 text-sm">{label}<select aria-label={label} disabled={!actionsEnabled||entry.gone||entry.busy||entry.pending!==null} value={entry.draft![field]} className="rounded-md border border-input bg-background px-2 py-1" onChange={event=>{entry.draft={...entry.draft!,[field]:event.target.value as QualificationAnswer};touch();}}><option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option></select></label>):null}
  {entry.view?.staleFields.length?<p className="text-xs text-muted-foreground">A cited source changed. Confirm those answers again.</p>:null}
  {entry.view?.evidence.length?<ul className="text-xs text-muted-foreground">{entry.view.evidence.map(e=><li key={e.field}>{fields.find(([f])=>f===e.field)?.[1]}: {e.sourceKind==='user_confirmation'?'your confirmation':e.sourceKind==='call_item'?'accepted call suggestion':e.sourceKind==='user_note'?'your meeting notes':'confirmed meeting note'} {entry.view!.sourceLinks.filter(link=>link.field===e.field).map(link=><a key={link.id} className="underline" href={link.target==='call'?`#call-${link.id}`:`#meeting-outcomes-${link.id}`} onClick={()=>{if(link.target==='meeting_notes'){outcomeEntry(memory,link.id).open=true;touch();}}}>View source</a>)}</li>)}</ul>:null}
  <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!actionsEnabled||entry.busy||entry.loading||!entry.draft||entry.gone||(entry.pending===null&&entry.view!==null&&entry.revision!==entry.view.revision)} onClick={()=>{void save();}}>{entry.busy?'Saving…':entry.pending?'Retry save':'Save qualification'}</Button><Button size="sm" variant="quiet" disabled={entry.busy||entry.loading||entry.pending!==null} onClick={()=>{void load();}}>Refresh qualification</Button></div>
  {entry.view&&entry.revision!==entry.view.revision?<div className="space-y-2"><p className="text-xs text-muted-foreground">Latest saved: {fields.map(([f,label])=>`${label}: ${entry.view![f]}`).join(' · ')}</p><Button size="sm" variant="outline" disabled={entry.busy} onClick={()=>{entry.revision=entry.view!.revision;entry.message='Your choices are kept. Save to confirm them against the latest version.';touch();}}>Keep my choices with latest version</Button></div>:null}
  {entry.message?<p role="status" className="text-xs text-muted-foreground">{entry.message}</p>:null}
 </section>:null}</div>;
}
