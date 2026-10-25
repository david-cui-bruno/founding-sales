import {useCallback,useEffect,useRef,useState,type JSX} from 'react';
import {manualProspectActivityListSchema,type ManualProspect,type ManualProspectActivityList,type ManualProspectActivityView,type ManualProspectActivityContent,type ManualProspectActivitySaveInput} from '@fss/contracts';
import {BrowserBoundaryError,type BrowserClient} from './BrowserClient.ts';
import {ManualProspectActivityForm} from './ManualProspectActivityForm.tsx';
import {MANUAL_ACTIVITY_PREFIX,dispatchManualActivity,reconcileManualActivity,readManualActivity} from './ManualProspectActivityDispatch.ts';
import {MANUAL_ACTIVITY_PENDING_KEY,type ManualActivityPending} from './ManualProspectActivityCustody.ts';
export function BrowserManualProspectActivity({client,prospect:p,isScopeCurrent=()=>true,onUnavailable}:{client:BrowserClient;prospect:ManualProspect;isScopeCurrent?:()=>boolean;onUnavailable?:()=>void}):JSX.Element|null{
 const [list,setList]=useState<ManualProspectActivityList|null>(null),[view,setView]=useState<ManualProspectActivityView|null>(null),[editing,setEditing]=useState(false),[creating,setCreating]=useState(false);
 const [pending,setPending]=useState<ManualActivityPending|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[broken,setBroken]=useState(false);
 const mounted=useRef(false),operation=useRef<symbol|null>(null);
 const refreshPending=useCallback(():void=>{try{setPending(client.manualActivity.read());}catch{setBroken(true);}},[client]);
 useEffect(()=>{
  mounted.current=true;const epoch=client.epoch;refreshPending();
  const clear=():void=>{operation.current=null;setView(null);setList(null);setEditing(false);setCreating(false);setPending(null);setNotice('');setBusy(false);};
  const unsubscribe=client.subscribe(()=>{if(!client.isCurrent(epoch)||client.current?.status!=='signed_in'||client.current.role!=='admin')clear();});
  const changed=(event:StorageEvent):void=>{if(event.key===MANUAL_ACTIVITY_PENDING_KEY)refreshPending();};
  globalThis.addEventListener('storage',changed);
  return ()=>{mounted.current=false;operation.current=null;unsubscribe();globalThis.removeEventListener('storage',changed);};
 },[client,refreshPending]);
 const run=(work:(current:()=>boolean)=>Promise<void>):void=>{
  // Synchronous guard precedes React's batched disabled state and hash/WebLock waits.
  if(operation.current!==null||busy||!isScopeCurrent())return;
  const token=Symbol('manual-activity'),epoch=client.epoch;operation.current=token;setBusy(true);setNotice('');
  const current=():boolean=>mounted.current&&operation.current===token&&isScopeCurrent()&&client.isCurrent(epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin';
  void work(current).catch(error=>{if(current()){setView(null);setEditing(false);setCreating(false);setNotice('Activity unavailable or outcome UNKNOWN. No automatic replay. Reconcile the exact pending command.');if(error instanceof BrowserBoundaryError&&error.reason==='refused')onUnavailable?.();}}).finally(()=>{if(current()){refreshPending();operation.current=null;setBusy(false);}});
 };
 const load=async(current:()=>boolean,afterId?:string):Promise<void>=>{
  setList(null);setView(null);setEditing(false);setCreating(false);
  const answer=await client.request(`${MANUAL_ACTIVITY_PREFIX}/list`,manualProspectActivityListSchema,{candidateId:p.candidateId,expectedCandidateRevision:p.revision,...(afterId?{afterId}:{})},()=>{if(!current())throw Error('Superseded activity list');});
  if(current())setList(answer);
 };
 const open=async(current:()=>boolean,attemptId:string):Promise<void>=>{setView(null);setEditing(false);setCreating(false);const answer=await readManualActivity(client,{candidateId:p.candidateId,candidateRevision:p.revision,attemptId},current);if(current()){setView(answer);if(answer.availability==='unavailable')onUnavailable?.();}};
 const save=(content:ManualProspectActivityContent|null):void=>run(async current=>{
  await client.manualActivity.exclusive(async()=>{
   if(!current())return;
   const payload:ManualProspectActivitySaveInput=content?{...content,candidateId:p.candidateId,expectedCandidateRevision:p.revision,...(view?.availability==='available'?{operation:'update',attemptId:view.attemptId,expectedActivityRevision:view.activityRevision}:{operation:'create',attemptId:crypto.randomUUID()})}:
    {operation:'withdraw',candidateId:p.candidateId,expectedCandidateRevision:p.revision,attemptId:view!.attemptId,expectedActivityRevision:view!.activityRevision};
   const saved=await dispatchManualActivity(client,payload,current);
   if(!current())return;setNotice(saved.message);setEditing(false);setCreating(false);setView(null);
   if(saved.accepted)await open(current,saved.held.attemptId);
  });
 });
 const reconcile=():void=>run(async current=>{
  await client.manualActivity.exclusive(async()=>{
   if(!current())return;
   const held=client.manualActivity.read();if(!held)return;
   setView(null);setEditing(false);setCreating(false);
   const state=await reconcileManualActivity(client,held,current);if(!current())return;
   setNotice(state==='unknown'?'Receipt UNKNOWN. Exact command remains held; no replacement or replay.':`Exact receipt ${state}.`);
   if(state==='accepted'&&held.candidateId===p.candidateId&&held.candidateRevision===p.revision)await open(current,held.attemptId);
  });
 });
 if(client.current?.status!=='signed_in'||client.current.role!=='admin')return null;
 const blocked=busy||broken||pending!==null;
 return <section aria-label="Private manual prospect activity" className="rounded-md border p-4">
  <h4>Manual activity for {p.presentation?.label??p.observedName}</h4>
  <p>Exact candidate {p.candidateId} · revision {p.revision}. UNVERIFIED · Contact authority not granted.</p>
  <p>Private user reports only. Recording places no call, creates no CRM record, callback, Today task, consent, suppression or send.</p>
  <button disabled={busy} onClick={()=>run(current=>load(current))}>Refresh manual activity</button>
  <button disabled={blocked} onClick={()=>{if(!isScopeCurrent())return;setView(null);setEditing(false);setCreating(true);}}>Record a user-performed attempt</button>
  {notice?<p role="status">{notice}</p>:null}{broken?<p role="alert">Activity custody unavailable. Saving blocked; no replacement command created.</p>:null}
  {pending?<div><p>Pending exact manual activity command {pending.commandId} · candidate {pending.candidateId}, revision {pending.candidateRevision}. No prose stored.</p><button disabled={busy||broken} onClick={reconcile}>Reconcile exact manual activity receipt</button></div>:null}
  {list?<div>{list.activities.length===0?<p>No manual reports returned for this candidate revision.</p>:null}{list.activities.map(row=><div key={row.attemptId}><button disabled={busy} onClick={()=>run(current=>open(current,row.attemptId))}>Open manual report {row.attemptId}</button><span> · {row.availability} · activity revision {row.activityRevision} · recorded {row.recordedAt}</span></div>)}{list.nextAfterId?<button disabled={busy} onClick={()=>run(current=>load(current,list.nextAfterId!))}>Next manual activity page</button>:null}</div>:null}
  {view?<div aria-label="Current manual report"><p>Report {view.attemptId} · activity revision {view.activityRevision} · {view.availability}</p>{view.availability==='available'?<>
   <p>User-reported result: {view.result.replaceAll('_',' ')} · not verified</p>
   {view.result==='do_not_call'?<p role="alert">Reported do not call. No automatic suppression was applied. This is not contact clearance.</p>:null}
   <p>Occurrence: {view.occurrence.kind==='known'?view.occurrence.occurredAt:'unknown'} · recorded {view.recordedAt}</p><p>Business note: {view.note??'none'}</p>
   {view.callback?<div><p>Callback intention: {view.callback.note??'none'}</p><p>Callback time: {view.callback.timing.kind==='unknown'?'unknown':`${view.callback.timing.localDate} ${view.callback.timing.localTime} ${view.callback.timing.sourceTimeZone} · ${view.callback.timing.dueAt}`}</p><p>No callback task or reminder created.</p></div>:null}
   <button disabled={blocked} onClick={()=>{if(!isScopeCurrent())return;setCreating(false);setEditing(true);}}>Correct this exact report</button><button disabled={blocked} onClick={()=>save(null)}>Withdraw mistaken report and clear its content</button>
  </>:<p>Content cleared. This ID cannot be restored.</p>}</div>:null}
  {creating||editing&&view?.availability==='available'?<ManualProspectActivityForm key={creating?'new':`${view!.attemptId}:${view!.activityRevision}`} {...(!creating&&view?.availability==='available'?{initial:view}:{})} disabled={blocked} onSave={save}/>:null}
 </section>;
}
