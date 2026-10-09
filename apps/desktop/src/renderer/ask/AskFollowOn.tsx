import {useEffect,useRef,useState} from 'react';
import {askActionAcknowledgmentSchema,askActionCreatePayloadSchema,askResponseSchema,crmCommitmentDueSchema} from '@fss/contracts';
import type {z} from 'zod';
import type {askReadSchema} from '@fss/contracts';
export interface AskFollowOnPorts {
 read(input:z.infer<typeof askReadSchema>):Promise<z.infer<typeof askResponseSchema>>;
 actionCreate(input:z.infer<typeof askActionCreatePayloadSchema>):Promise<z.infer<typeof askActionAcknowledgmentSchema>>;
}
export function AskFollowOn({ports,enabled,requestId,expectedVersion,finding,onUnavailable}:{ports:Partial<AskFollowOnPorts>;enabled:boolean;onUnavailable:()=>void}&Pick<z.infer<typeof askActionCreatePayloadSchema>,'requestId'|'expectedVersion'|'finding'>){
 const [kind,setKind]=useState(''),[text,setText]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState<string|null>(null);
 const [date,setDate]=useState(''),[zone,setZone]=useState('');
 const due=date===''?null:{kind:'date' as const,date,zone,expression:date};
 const validDue=crmCommitmentDueSchema.safeParse(due).success;
 const [recordKind,setRecordKind]=useState<'people'|'firms'>('people'),[query,setQuery]=useState('');
 const [records,setRecords]=useState<Extract<z.infer<typeof askResponseSchema>,{operation:'records'}>['records']>([]);
 const [target,setTarget]=useState<Extract<z.infer<typeof askResponseSchema>,{operation:'records'}>['records'][number]|null>(null);
 const epoch=useRef(0);
 async function find(){
  if(!enabled||busy||!ports.read||!query.trim())return;
  const captured=++epoch.current;setRecords([]);setTarget(null);setConfirmed(false);setBusy(true);
  try{const page=askResponseSchema.parse(await ports.read({operation:'records',query:query.trim(),kind:recordKind,limit:20}));if(captured!==epoch.current)return;if(page.operation!=='records')throw new Error('record_changed');setRecords(page.records);if(!page.scanComplete)setNotice('More records may match. Choose explicitly; narrow the name if needed.');}
  catch{if(captured===epoch.current){setRecords([]);setNotice('Record lookup is unavailable. Read current access again.');}}
  finally{if(captured===epoch.current)setBusy(false);}
 }
 useEffect(()=>()=>{epoch.current++;},[]);
 async function save(){
  if(!enabled||busy||!confirmed||(kind!=='preference'&&kind!=='note'&&kind!=='task')||!ports.actionCreate)return;
  const captured=++epoch.current;setBusy(true);setNotice(null);
  try{
   const selectedTarget=target?.kind==='firm'?{kind:'firm',firmId:target.recordId}:target?.kind==='person'?{kind:'person',personId:target.recordId}:null;
   const action=kind==='preference'?{kind:'preference',text}:kind==='task'?{kind:'task',label:text,due,target:selectedTarget}:{kind:'note',text,target:selectedTarget};
   const input=askActionCreatePayloadSchema.parse({requestId,expectedVersion,finding,action});
   const receipt=askActionAcknowledgmentSchema.parse(await ports.actionCreate(input));
   if(captured!==epoch.current)return;
   if(receipt.kind!==input.action.kind)throw new Error('changed_action');
   setText('');setConfirmed(false);setNotice(kind==='preference'?'Preference proposal saved.':kind==='task'?'Manual task saved.':'Human annotation saved.');
  }catch{if(captured===epoch.current)onUnavailable();}
  finally{if(captured===epoch.current)setBusy(false);}
 }
 return <section aria-label='Explicit follow-on action'>
  <p>Choose and confirm a human action. Asking has not changed any record.</p>
  <label>Follow-on action<select aria-label='Follow-on action' value={kind} disabled={!enabled||busy} onChange={event=>{setKind(event.target.value);setDate('');setZone('');setText('');setTarget(null);setRecords([]);setConfirmed(false);setNotice(null);}}><option value=''>Choose an action</option><option value='task'>Manual task</option><option value='note'>Human record annotation</option><option value='preference'>Preference proposal</option></select></label>
  {(kind==='note'||kind==='task')&&<div>
   <p>{kind==='task'?'Your manual task is separate from a correspondent’s promise.':'Your annotation is not an original communication or a verified promise.'}</p>
   <label>Action record kind<select aria-label='Action record kind' value={recordKind} disabled={!enabled||busy} onChange={event=>{epoch.current++;setRecordKind(event.target.value==='firms'?'firms':'people');setTarget(null);setRecords([]);setConfirmed(false);}}><option value='people'>People</option><option value='firms'>Firms</option></select></label>
   <label>Action record name<input aria-label='Action record name' maxLength={160} value={query} disabled={!enabled||busy} onChange={event=>{epoch.current++;setQuery(event.target.value);setTarget(null);setRecords([]);setConfirmed(false);}}/></label>
   <button disabled={!enabled||busy||!ports.read||!query.trim()} onClick={()=>{void find();}}>Find action record</button>
   {records.map(record=><button key={record.recordId} disabled={!enabled||busy} onClick={()=>{setTarget(record);setConfirmed(false);}}>Use {record.kind} {record.name}</button>)}
   {target!==null&&<p>Selected {target.kind}: {target.name}</p>}
   <label>{kind==='task'?'Your task':'Your record annotation'}<textarea aria-label={kind==='task'?'Your task':'Your record annotation'} maxLength={kind==='task'?300:2000} value={text} disabled={!enabled||busy} onChange={event=>{setText(event.target.value);setConfirmed(false);}}/></label>
   {kind==='task'&&<div><label>Task due date (optional)<input aria-label='Task due date (optional)' type='date' value={date} disabled={!enabled||busy} onChange={event=>{setDate(event.target.value);setConfirmed(false);}}/></label>{date!==''&&<label>Task time zone<input aria-label='Task time zone' maxLength={100} value={zone} disabled={!enabled||busy} onChange={event=>{setZone(event.target.value);setConfirmed(false);}}/></label>}{!validDue&&<p>Choose a valid date and time zone.</p>}</div>}
   <label><input type='checkbox' checked={confirmed} disabled={!enabled||busy||target===null||!validDue} onChange={event=>setConfirmed(event.target.checked)}/>{kind==='task'?'Confirm this manual task':'Confirm this human annotation'}</label>
   <button disabled={!enabled||busy||!confirmed||!text.trim()||target===null||!validDue||!ports.actionCreate} onClick={()=>{void save();}}>{kind==='task'?'Create manual task':'Save annotation'}</button>
  </div>}
  {kind==='preference'&&<div>
   <p>Private proposal only. This does not change targeting or settings.</p>
   <label>Proposed preference<textarea aria-label='Proposed preference' maxLength={2000} value={text} disabled={!enabled||busy} onChange={event=>{setText(event.target.value);setConfirmed(false);}}/></label>
   <label><input type='checkbox' checked={confirmed} disabled={!enabled||busy} onChange={event=>setConfirmed(event.target.checked)}/>Confirm this preference proposal</label>
   <button disabled={!enabled||busy||!confirmed||!text.trim()||!ports.actionCreate} onClick={()=>{void save();}}>Save preference proposal</button>
  </div>}
  {notice!==null&&<p role='status'>{notice}</p>}
 </section>;
}
