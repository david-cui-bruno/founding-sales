import {useEffect,useRef,useState,type JSX} from 'react';
import {useSessionEpoch} from '../app/drafts.tsx';
import {operations} from '../app/bridges.ts';
import {Button} from '../ui/button.tsx';
import {DISCOVERY_FILE_BYTES,prepareDiscoveryBatch,type DiscoveryBatch} from './discoveryImportBatch.ts';
import {createDiscoveryImportController,type DiscoveryImportController,type DiscoveryProgress,type DiscoverySavePort} from './discoveryImportController.ts';
import {discoveryList} from './DiscoveryCandidates.tsx';
import type {DiscoveryListPort} from './discoveryImportReconcile.ts';
export interface DiscoveryImportAuthority {isAdmin:boolean;current():boolean}
interface Props {authority:DiscoveryImportAuthority;enabled:boolean;privacyKey:string;save?:DiscoverySavePort;list?:DiscoveryListPort}
const saveDiscovery:DiscoverySavePort=async input=>{
  const bridge=operations();if(!bridge)return {result:null,reason:'unavailable'};
  return bridge.command('sourcing.discoverySave',input);
};
const epochs=new WeakMap<object,number>();let nextEpoch=0;
export function DiscoveryImport(props:Props):JSX.Element|null {
  const epoch=useSessionEpoch();let key=0;
  if(epoch){key=epochs.get(epoch)??++nextEpoch;epochs.set(epoch,key);}
  return props.authority.isAdmin?<ImportSession key={`${props.privacyKey}:${key}`} {...props}/>:null;
}
function ImportSession({authority,enabled,save=saveDiscovery,list=discoveryList}:Props):JSX.Element {
  const [batch,setBatch]=useState<DiscoveryBatch|null>(null),[progress,setProgress]=useState<DiscoveryProgress|null>(null);
  const [message,setMessage]=useState<string|null>(null),[reading,setReading]=useState(false),[confirmed,setConfirmed]=useState(false);
  const lockedDigest=useRef<string|null>(null);
  const controller=useRef<DiscoveryImportController|null>(null),alive=useRef(true),selection=useRef(0),live=useRef({authority,enabled});
  live.current={authority,enabled};
  const current=()=>alive.current&&live.current.enabled&&live.current.authority.isAdmin&&live.current.authority.current();
  useEffect(()=>{alive.current=true;const selections=selection;return()=>{alive.current=false;++selections.current;controller.current?.cancel();};},[]);
  useEffect(()=>{
    if(!enabled){++selection.current;controller.current?.cancel();controller.current=null;setBatch(null);setProgress(null);setConfirmed(false);setReading(false);setMessage(null);}
  },[enabled]);
  const choose=async(file:File|undefined)=>{
    if(!current()||controller.current?.state().busy)return;
    const mine=++selection.current,isCurrent=()=>current()&&mine===selection.current;
    controller.current?.cancel();controller.current=null;setBatch(null);setProgress(null);setConfirmed(false);setMessage(null);
    if(!file)return;
    if(file.size>DISCOVERY_FILE_BYTES){setMessage('File exceeds the 10 MB limit. Nothing was sent.');return;}
    setReading(true);
    try{
      if(!isCurrent())return;
      const bytes=await file.arrayBuffer();if(!isCurrent())return;
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
      const prepared=await prepareDiscoveryBatch(text,isCurrent);if(!isCurrent())return;
      if(lockedDigest.current!==null&&lockedDigest.current!==prepared.digest){setMessage('This session already attempted a different batch. Select the same unchanged file. Do not replace ambiguous or refused commands with new IDs.');return;}
      const next=createDiscoveryImportController(prepared,{save,list},isCurrent,value=>{if(isCurrent())setProgress(value);});
      controller.current=next;setBatch(prepared);setProgress(next.state());
    }catch{if(isCurrent())setMessage('Invalid raw discovery JSON, duplicate source identity, changed payload or unsupported entry. Nothing was sent. Select an unchanged valid file of 1–2000 rows.');}
    finally{if(isCurrent())setReading(false);}
  };
  const busy=reading||progress?.busy===true;
  const start=()=>{if(current()&&confirmed&&!busy&&batch){lockedDigest.current=batch.digest;void controller.current?.run();}};
  const cancel=()=>{++selection.current;controller.current?.cancel();controller.current=null;setBatch(null);setProgress(null);setConfirmed(false);setReading(false);setMessage('Cancelled. An in-flight save may have completed. Select the same unchanged file to reconcile or explicitly resume with the same IDs.');};
  // Disabled or generation-stale state must never reveal a retained file summary.
  if(!enabled||!authority.current())return <section aria-label="Import raw discovery"><p>Raw discovery import unavailable for this session.</p></section>;
  const notices=batch?[...new Map(batch.commands.flatMap(command=>command.origins.flatMap(origin=>origin.notices)).map(notice=>[`${notice.sha256}:${notice.url}:${notice.label}`,notice])).values()]:[];
  return <section aria-label="Import raw discovery" className="space-y-3 rounded-lg border border-border p-4">
    <h3 className="font-medium">Import raw discovery JSON</h3>
    <p>Admin only. Raw observations, not qualified leads. Fit, website association and office support remain unknown. No fetching, admission, contact or sending.</p>
    <label>Select raw discovery JSON (10 MB, 2000 rows maximum)<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';void choose(file);}}/></label>
    {reading?<p role="status">Validating every entry before any save…</p>:null}
    {message?<p role="status">{message}</p>:null}
    {batch&&progress?<>
      <p>{batch.commands.length} raw rows · {batch.observations} exact source observations · {batch.unknownWebsites} unknown websites · {batch.noticeReferences} notice references. Existing contract name trims: {batch.contractNameTrims}. Batch digest (original file): {batch.digest}</p>
      <details><summary>Retained notice references (inert, not fetched)</summary><ul>{notices.map(notice=><li key={`${notice.sha256}:${notice.url}:${notice.label}`}>{notice.label} · {notice.url} · SHA256 {notice.sha256}</li>)}</ul></details>
      <label><input type="checkbox" checked={confirmed} disabled={busy||progress.refusal} onChange={event=>setConfirmed(event.target.checked)}/>I confirm retaining this selected file as unverified raw observations only. Receipt replay does not prove current queue presence.</label>
      <div className="flex gap-2"><Button disabled={!confirmed||busy||progress.refusal||progress.acknowledged===batch.commands.length} onClick={start}>{progress.phase==='ready'?'Confirm and save raw observations':'Explicitly resume same payload and IDs'}</Button><Button variant="quiet" disabled={busy} onClick={()=>{if(current())void controller.current?.reconcile();}}>Reconcile current queue (read only)</Button><Button variant="quiet" onClick={cancel}>Cancel raw import</Button></div>
      <p role="status">{progress.phase} · {progress.acknowledged}/{batch.commands.length} unique commands acknowledged in this selection. Historical receipt newlyPersisted sum: {progress.receiptNewlyPersisted} · exactDuplicates sum: {progress.receiptExactDuplicates}. These may be replayed, not CRM net-new counts.</p>
      {progress.reason?<p role="alert">Stopped: {progress.reason}. No automatic retry. {progress.uncertain?'Outcome may be ambiguous. Explicit resume keeps the exact same pending payload and command ID.':'Refusals require disposition, not replacement IDs.'}</p>:null}
      {progress.presence?<p role="status">Observed in two matching bounded queue scans: {progress.presence.present} exact rows present, {progress.presence.missing} missing, {progress.presence.conflicts} conflicting, {progress.presence.dismissed} dismissed (not revived). Not a transaction snapshot or proof of qualification/callability. Missing rows are not present just because a receipt exists. {progress.presence.requests} list requests.</p>:null}
    </>:null}
  </section>;
}
