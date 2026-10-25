import {useState,type JSX} from 'react';
import {callbackInstant,manualProspectActivityContentSchema,manualProspectActivityResultSchema,type ManualProspectActivityContent} from '@fss/contracts';
export function ManualProspectActivityForm({initial,disabled,onSave}:{initial?:ManualProspectActivityContent;disabled:boolean;onSave:(content:ManualProspectActivityContent)=>void}):JSX.Element{
 const [performed,setPerformed]=useState(initial?.performedByUser??false),[result,setResult]=useState(initial?.result??'unknown');
 const [note,setNote]=useState(initial?.note??''),[occurrence,setOccurrence]=useState(initial?.occurrence.kind==='known'?initial.occurrence.occurredAt:'');
 const [callbackNote,setCallbackNote]=useState(initial?.callback?.note??''),[timed,setTimed]=useState(initial?.callback?.timing.kind==='confirmed');
 const timing=initial?.callback?.timing;
 const [date,setDate]=useState(timing?.kind==='confirmed'?timing.localDate:''),[time,setTime]=useState(timing?.kind==='confirmed'?timing.localTime:''),[zone,setZone]=useState(timing?.kind==='confirmed'?timing.sourceTimeZone:'');
 const [confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
 const due=timed&&date&&time&&zone?callbackInstant(date,time,zone):null;
 const save=():void=>{
  const parsed=manualProspectActivityContentSchema.safeParse({performedByUser:performed,channel:'manual_phone',occurrence:occurrence?{kind:'known',occurredAt:occurrence}:{kind:'unknown'},result,note:note||null,callback:result==='callback_requested'?{note:callbackNote||null,timing:timed?{kind:'confirmed',localDate:date,localTime:time,sourceTimeZone:zone,dueAt:due??''}:{kind:'unknown'}}:null});
  if(!parsed.success||(timed&&result==='callback_requested'&&!confirmed)){setError('Confirm your user-performed report and valid explicit times. No action was executed.');return;}
  setError('');onSave(parsed.data);
 };
 return <form aria-label="Manual activity report" onSubmit={event=>{event.preventDefault();save();}}>
  <fieldset disabled={disabled}>
   <legend>Record or correct a user report, not a call action</legend>
   <label><input type="checkbox" checked={performed} onChange={event=>setPerformed(event.target.checked)}/>I performed this manual attempt (user report, not verified)</label>
   <label>Occurrence UTC instant, blank means unknown<input placeholder="YYYY-MM-DDTHH:mm:ss.sssZ" value={occurrence} onChange={event=>setOccurrence(event.target.value)}/></label>
   <label>Reported result<select aria-label="Reported result" value={result} onChange={event=>{setResult(manualProspectActivityResultSchema.parse(event.target.value));setCallbackNote('');setTimed(false);setDate('');setTime('');setZone('');setConfirmed(false);}}>{manualProspectActivityResultSchema.options.map(value=><option key={value} value={value}>{value.replaceAll('_',' ')}</option>)}</select></label>
   {result==='do_not_call'?<p role="alert">Reported do not call. No automatic suppression was applied. This report grants no contact clearance. Use the existing suppression workflow separately before any future contact.</p>:null}
   <label>Relevant business result note<textarea aria-label="Relevant business result note" maxLength={1000} value={note} onChange={event=>setNote(event.target.value)}/></label>
   <p>Do not paste transcripts, personal numbers or sensitive data. Notes are private current content, not consent or qualification.</p>
   {result==='callback_requested'?<div>
    <label>Callback intention note<textarea aria-label="Callback intention note" maxLength={500} value={callbackNote} onChange={event=>setCallbackNote(event.target.value)}/></label>
    <label><input type="checkbox" checked={timed} onChange={event=>{setTimed(event.target.checked);setConfirmed(false);}}/>Record an explicit callback time (otherwise unknown)</label>
    {timed?<div>
     <label>Callback local date<input type="date" value={date} onChange={event=>{setDate(event.target.value);setConfirmed(false);}}/></label>
     <label>Callback local time<input type="time" value={time} onChange={event=>{setTime(event.target.value);setConfirmed(false);}}/></label>
     <label>Callback source time zone<input placeholder="America/New_York" value={zone} onChange={event=>{setZone(event.target.value);setConfirmed(false);}}/></label>
     <p>Resolved callback: {due??'unresolved'} · {zone||'zone unknown'}. Ambiguous/nonexistent local times are refused by the server.</p>
     <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>I confirm this exact callback local time, zone and UTC instant</label>
    </div>:<p>Callback time unknown. No task or reminder will be created.</p>}
   </div>:null}
   <button type="submit">Save manual report</button>
  </fieldset>{error?<p role="status">{error}</p>:null}
 </form>;
}
