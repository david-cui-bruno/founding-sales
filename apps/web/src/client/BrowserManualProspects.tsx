import {useCallback,useEffect,useRef,useState,type JSX} from 'react';
import {manualProspectListSchema,type ManualProspect,type CallingSubject} from '@fss/contracts';
import type {z} from 'zod';
import type {BrowserClient} from './BrowserClient.ts';
import {dispatchManualProspect} from './ManualProspectDispatch.ts';
import type {PendingManualProspect} from './ManualProspectPending.ts';
import {ManualProspectCard} from './ManualProspectCard.tsx';
import {BrowserManualProspectActivity} from './BrowserManualProspectActivity.tsx';
import {ManualProspectTable} from './ManualProspectTable.tsx';
import {ManualProspectPreparation} from './ManualProspectPreparation.tsx';

export function BrowserManualProspects({client,onOpenCalling}:{client:BrowserClient;onOpenCalling?:(subject:CallingSubject)=>void}):JSX.Element|null{
 const [state,setState]=useState('all'),[offset,setOffset]=useState(0),[reload,setReload]=useState(0);
 const [page,setPage]=useState<z.infer<typeof manualProspectListSchema>|null>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [pending,setPending]=useState<PendingManualProspect|null>(null),[custodyError,setCustodyError]=useState(false);
 const [activity,setActivity]=useState<ManualProspect|null>(null);
 const [preparing,setPreparing]=useState(false);
 const scope=useRef(0);
 const activityLease=useRef(0);
 // Revoke event/await continuations before React commits the replacement view.
 const clearScope=useCallback(():void=>{scope.current++;setPreparing(false);setActivity(null);},[]);
 const [selected,setSelected]=useState<string|null>(null),[focus,setFocus]=useState(false);
 const inspector=useRef<HTMLDivElement>(null),restoreFocus=useRef(false);
 const operation=useRef<symbol|null>(null),mounted=useRef(false);
 useEffect(()=>{
  mounted.current=true;let epoch=client.epoch;
  const clear=():void=>{clearScope();operation.current=null;restoreFocus.current=false;setPage(null);setSelected(null);setPending(null);setBusy(false);setNotice('');};
  clear();setCustodyError(false);
  const unsubscribe=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;clear();}});
  try{setPending(client.manualProspects.read());}catch{setCustodyError(true);}
  return ()=>{mounted.current=false;operation.current=null;unsubscribe();};
 },[client,clearScope]);
 useEffect(()=>{
  clearScope();setPage(null);setNotice('');
  if(client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  const token=Symbol('manual-list'),epoch=client.epoch;operation.current=token;setBusy(true);
  const current=():boolean=>mounted.current&&operation.current===token&&client.isCurrent(epoch);
  void client.request('/sourcing/candidates/prospects/list',manualProspectListSchema,{state,offset},()=>{if(!current())throw Error('Superseded manual list');})
   .then(answer=>{if(current())setPage(answer);})
   .catch(()=>{if(current())setNotice('Manual worklist unavailable or refused. This is not an empty inventory.');})
   .finally(()=>{if(current()){operation.current=null;setBusy(false);}});
  return ()=>{if(operation.current===token)operation.current=null;};
 },[client,state,offset,reload,clearScope]);
 const feedback=async(prospect:ManualProspect|null,nextState?:'kept'|'skipped'|'wrong_number'):Promise<void>=>{
  // React may batch duplicate clicks before the busy state reaches the buttons.
  if(operation.current!==null||busy||custodyError)return;
  restoreFocus.current=inspector.current?.contains(document.activeElement)??false;
  clearScope();
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
 const prospects=page?.prospects??[],chosen=prospects.find(p=>p.candidateId===selected)??prospects[0]??null;
 const index=chosen?prospects.indexOf(chosen):-1;
 const viewScope=scope.current,epoch=client.epoch;
 const currentScope=():boolean=>mounted.current&&scope.current===viewScope&&client.isCurrent(epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin';
 const activityVersion=activityLease.current;
 const currentActivityScope=():boolean=>currentScope()&&activityLease.current===activityVersion;
 const openActivity=():void=>{if(currentScope()&&chosen&&activity===null){activityLease.current++;setActivity(chosen);}};
 const closeActivity=():void=>{if(currentActivityScope()){activityLease.current++;setActivity(null);}};
 const activityUnavailable=():void=>{if(currentActivityScope()){clearScope();setPage(null);setNotice('Private activity unavailable or outcome UNKNOWN. Preparation cleared. Refresh retained worklist to review current access, then reconcile any exact pending activity command. No automatic replay.');}};
 useEffect(()=>{
  if(page&&restoreFocus.current){restoreFocus.current=false;inspector.current?.querySelector('h3')?.focus();}
 },[page]);
 const select=(id:string):void=>{
  clearScope();
  setSelected(id);
  // On a stacked viewport, selection should lead to the inspector, not leave it below 50 rows.
  if(globalThis.matchMedia?.('(max-width: 900px)').matches){
   setFocus(true);
   requestAnimationFrame(()=>inspector.current?.querySelector('h3')?.focus());
  }
 };
 if(client.current?.status!=='signed_in'||client.current.role!=='admin')return null;
 return <section id="prospects" aria-label="Manual prospect worklist" className="manual-worklist">
  <div className="manual-page-top"><div><p className="manual-eyebrow">Retained observations</p><h2>Retained review</h2><p>Keep the observations worth another look.</p></div>
   <div className="manual-view-switch" role="group" aria-label="Prospect view"><button aria-pressed={!focus} onClick={()=>setFocus(false)}>Worklist</button><button aria-pressed={focus} onClick={()=>setFocus(true)}>Focus</button></div>
  </div>
  <p className="manual-authority">UNVERIFIED · Contact authority not granted. These are observations, not unique or callable Firms. No source refresh or outreach runs here.</p>
  <div className="manual-toolbar"><label>Manual state <select value={state} disabled={busy} onChange={event=>{clearScope();setPage(null);setSelected(null);setOffset(0);setState(event.target.value);}}>{['all','new','kept','skipped','wrong_number'].map(value=><option key={value} value={value}>{value.replaceAll('_',' ')}</option>)}</select></label>
   <button disabled={busy} onClick={()=>{clearScope();setPage(null);setReload(value=>value+1);}}>Refresh retained worklist</button><p>At most 50 observations per page.<br/>Pages replace, not accumulate.</p>
  </div>
  {busy?<p role="status">Loading manual worklist or recording feedback.</p>:null}
  {notice?<p role="status">{notice}</p>:null}{custodyError?<p role="alert">Pending feedback storage unavailable. Dispatch blocked. No replacement command created.</p>:null}
  {pending&&!pending.receipt?<div><p>Uncertain manual feedback for candidate {pending.payload.candidateId}, revision {pending.payload.expectedRevision}. Exact command {pending.payload.commandId}.</p><button disabled={busy||custodyError} onClick={()=>{void feedback(null);}}>Reconcile same manual feedback</button></div>:null}
  {page?.prospects.length===0?<div className="manual-empty"><h3>No retained prospects in this view.</h3><p>No retained prospects returned for this state and page. This is not a global inventory count.</p>{state!=='all'||offset!==0?<button disabled={busy} onClick={()=>{setState('all');setOffset(0);}}>Return to first page, all states</button>:null}</div>:null}
  {page&&chosen?<div className={`manual-workspace${focus?' manual-focus':''}`}>
   {!focus?<ManualProspectTable prospects={prospects} selected={chosen.candidateId} select={select}/>:null}
   <div ref={inspector} className="manual-inspector" aria-label="Selected prospect inspector" role="region">
   <div className="manual-inspector-nav">{focus?<button onClick={()=>{setFocus(false);requestAnimationFrame(()=>document.getElementById(`manual-row-${chosen.candidateId}`)?.focus());}}>← Back to retained review</button>:null}<span>{index+1} / {prospects.length} on this page</span><div><button aria-label="Previous prospect" disabled={index<=0} onClick={()=>select(prospects[index-1]!.candidateId)}>←</button><button aria-label="Next prospect" disabled={index>=prospects.length-1} onClick={()=>select(prospects[index+1]!.candidateId)}>→</button></div></div>
    <ManualProspectCard key={`${chosen.candidateId}:${chosen.revision}`} prospect={chosen} disabled={busy||custodyError||(pending!==null&&!pending.receipt)} feedback={(value)=>{if(currentScope())void feedback(chosen,value);}} activity={openActivity} prepare={()=>{if(currentScope()){setFocus(true);setPreparing(true);}}}/>
    {onOpenCalling?<button disabled={busy} onClick={()=>{if(currentScope()&&operation.current===null)onOpenCalling({kind:'candidate',candidateId:chosen.candidateId,expectedCandidateRevision:chosen.revision});}}>Open calling brief</button>:null}
    {preparing?<ManualProspectPreparation key={`prepare:${viewScope}:${chosen.candidateId}:${chosen.revision}`} prospect={chosen} isScopeCurrent={currentScope} openActivity={openActivity}/>:null}
    {activity&&activity.candidateId===chosen.candidateId&&activity.revision===chosen.revision?<div><button onClick={closeActivity}>Close private manual activity</button><BrowserManualProspectActivity key={`activity:${viewScope}:${activityVersion}:${chosen.candidateId}:${chosen.revision}`} client={client} prospect={activity} isScopeCurrent={currentActivityScope} onUnavailable={activityUnavailable}/></div>:null}
   </div>
  </div>:null}
  <div className="manual-pagination"><p>Offset {offset} · {page?`${prospects.length} returned on this page`:'No current page'}{page?.hasMore?' · More observations available':''}</p><div><button disabled={busy||offset===0} onClick={()=>{clearScope();setPage(null);setSelected(null);setOffset(value=>Math.max(0,value-50));}}>Previous prospect page</button><button disabled={busy||page?.hasMore!==true||offset>999950} onClick={()=>{clearScope();setPage(null);setSelected(null);setOffset(value=>value+50);}}>Next prospect page</button></div></div>
  <p className="manual-footnote">Suggested labels and apparent classifications are not identity decisions or fit filters. Possible duplicates remain separate exact observations. Unknown phone does not block review.</p>
 </section>;
}
