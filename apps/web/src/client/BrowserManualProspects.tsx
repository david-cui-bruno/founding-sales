import {useEffect,useRef,useState,type JSX} from 'react';
import {manualProspectListSchema,type ManualProspect} from '@fss/contracts';
import type {z} from 'zod';
import type {BrowserClient} from './BrowserClient.ts';
import {dispatchManualProspect} from './ManualProspectDispatch.ts';
import type {PendingManualProspect} from './ManualProspectPending.ts';
import {ManualProspectCard} from './ManualProspectCard.tsx';

export function BrowserManualProspects({client}:{client:BrowserClient}):JSX.Element|null{
 const [state,setState]=useState('all'),[offset,setOffset]=useState(0),[reload,setReload]=useState(0);
 const [page,setPage]=useState<z.infer<typeof manualProspectListSchema>|null>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [pending,setPending]=useState<PendingManualProspect|null>(null),[custodyError,setCustodyError]=useState(false);
 const operation=useRef<symbol|null>(null),mounted=useRef(false);
 useEffect(()=>{
  mounted.current=true;let epoch=client.epoch;
  const clear=():void=>{operation.current=null;setPage(null);setPending(null);setBusy(false);setNotice('');};
  clear();setCustodyError(false);
  const unsubscribe=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;clear();}});
  try{setPending(client.manualProspects.read());}catch{setCustodyError(true);}
  return ()=>{mounted.current=false;operation.current=null;unsubscribe();};
 },[client]);
 useEffect(()=>{
  setPage(null);setNotice('');
  if(client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  const token=Symbol('manual-list'),epoch=client.epoch;operation.current=token;setBusy(true);
  const current=():boolean=>mounted.current&&operation.current===token&&client.isCurrent(epoch);
  void client.request('/sourcing/candidates/prospects/list',manualProspectListSchema,{state,offset},()=>{if(!current())throw Error('Superseded manual list');})
   .then(answer=>{if(current())setPage(answer);})
   .catch(()=>{if(current())setNotice('Manual worklist unavailable or refused. This is not an empty inventory.');})
   .finally(()=>{if(current()){operation.current=null;setBusy(false);}});
  return ()=>{if(operation.current===token)operation.current=null;};
 },[client,state,offset,reload]);
 const feedback=async(prospect:ManualProspect|null,nextState?:'kept'|'skipped'|'wrong_number'):Promise<void>=>{
  // React may batch duplicate clicks before the busy state reaches the buttons.
  if(operation.current!==null||busy||custodyError)return;
  const token=Symbol('manual-feedback'),epoch=client.epoch;operation.current=token;setBusy(true);setNotice('');
  const current=():boolean=>mounted.current&&operation.current===token&&client.isCurrent(epoch);
  try{
   const held=prospect&&nextState?client.manualProspects.prepare({candidateId:prospect.candidateId,expectedRevision:prospect.revision,state:nextState}):client.manualProspects.read();
   if(!held)throw Error('No pending feedback');setPending(held);
   const message=await dispatchManualProspect(client,held,current);
   if(current()){setPending(client.manualProspects.read());setNotice(message);setReload(value=>value+1);}
  }catch{if(current()){setNotice('Feedback outcome unknown or dispatch refused. No automatic replay. Reconcile the exact pending command explicitly.');try{setPending(client.manualProspects.read());}catch{setCustodyError(true);}}}
  finally{if(current()){operation.current=null;setBusy(false);}}
 };
 if(client.current?.status!=='signed_in'||client.current.role!=='admin')return null;
 return <section aria-label="Manual prospect worklist" className="space-y-3 rounded-md border p-4">
  <h3>Unverified prospects</h3><p>Compact retained queue. Suggested labels and apparent company / non company / unresolved classifications are not identity decisions or fit filters. Unknown phone is expected. Keep, skip or flag a wrong number without qualification.</p>
  <p>UNVERIFIED · Contact authority not granted. These are observations, not unique or callable Firms. No source refresh or outreach runs here.</p>
  <label>Manual state <select value={state} disabled={busy} onChange={event=>{setPage(null);setOffset(0);setState(event.target.value);}}>{['all','new','kept','skipped','wrong_number'].map(value=><option key={value} value={value}>{value.replaceAll('_',' ')}</option>)}</select></label>
  <button disabled={busy} onClick={()=>{setReload(value=>value+1);}}>Refresh retained worklist</button>
  <p>Offset {offset} · At most 50 retained prospects per page. Pages replace previous observations.</p>
  <button disabled={busy||offset===0} onClick={()=>{setOffset(value=>Math.max(0,value-50));}}>Previous prospect page</button>
  <button disabled={busy||page?.hasMore!==true||offset>999950} onClick={()=>{setOffset(value=>value+50);}}>Next prospect page</button>
  {busy?<p role="status">Loading manual worklist or recording feedback.</p>:null}
  {notice?<p role="status">{notice}</p>:null}{custodyError?<p role="alert">Pending feedback storage unavailable. Dispatch blocked. No replacement command created.</p>:null}
  {pending&&!pending.receipt?<div><p>Uncertain manual feedback for candidate {pending.payload.candidateId}, revision {pending.payload.expectedRevision}. Exact command {pending.payload.commandId}.</p><button disabled={busy||custodyError} onClick={()=>{void feedback(null);}}>Reconcile same manual feedback</button></div>:null}
  {page?.prospects.length===0?<p>No retained prospects returned for this state and page.</p>:null}
  {page?.prospects.map(prospect=><ManualProspectCard key={`${prospect.candidateId}:${prospect.revision}`} prospect={prospect} disabled={busy||custodyError||(pending!==null&&!pending.receipt)} feedback={(value)=>{void feedback(prospect,value);}}/>)}
 </section>;
}
