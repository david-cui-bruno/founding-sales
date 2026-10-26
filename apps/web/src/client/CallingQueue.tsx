import {useEffect,useRef,useState,type JSX} from 'react';
import {todayActionsV4ResponseSchema,manualProspectListSchema,type CallingSubject,type ManualProspect,type TodayActionV4} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {manualProspectLabel} from './manualProspectPresentation.ts';
export interface CallingQueueEntry{subject:CallingSubject;label:string;prospect?:ManualProspect;action?:TodayActionV4;}
/** Existing current prepared actions or raw observations, never a reservation queue. */
export function CallingQueue({client,onSelect,disabled}:{client:BrowserClient;onSelect:(entry:CallingQueueEntry)=>void;disabled:boolean}):JSX.Element{
 const [mode,setMode]=useState<'prepared'|'retained'>('prepared'),[entries,setEntries]=useState<CallingQueueEntry[]>([]),[offset,setOffset]=useState(0),[more,setMore]=useState(false),[reload,setReload]=useState(0),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const scope=useRef(0);
 const changeMode=(next:typeof mode):void=>{if(next===mode)return;scope.current++;setMode(next);};
 useEffect(()=>{const mine=++scope.current,epoch=client.epoch;let mounted=true;const current=():boolean=>mounted&&scope.current===mine&&client.isCurrent(epoch)&&client.current?.status==='signed_in';setEntries([]);setBusy(true);setNotice('Loading current supply…');
  const read=async():Promise<void>=>{try{if(mode==='prepared'){
   const answer=await client.request('/today/actions/v4',todayActionsV4ResponseSchema,undefined,()=>{if(!current())throw Error('Queue changed');});if(!current())return;
   if(client.current?.status!=='signed_in'||answer.workspaceId!==client.current.workspaceId)throw Error('Workspace changed');
   setEntries(answer.actions.flatMap(action=>action.kind==='research'&&(action.target.kind==='qualified_research'||action.target.kind==='automatic_research')?[{subject:{kind:'firm' as const,firmId:action.target.firmId},label:action.subject,action}]:[]));setMore(false);
  }else{
   const answer=await client.request('/sourcing/candidates/prospects/list',manualProspectListSchema,{state:'all',offset},()=>{if(!current())throw Error('Queue changed');});if(!current())return;
   setEntries(answer.prospects.map(prospect=>({subject:{kind:'candidate' as const,candidateId:prospect.candidateId,expectedCandidateRevision:prospect.revision},label:manualProspectLabel(prospect),prospect})));setMore(answer.hasMore);
  }setNotice('');}catch{if(current())setNotice('Current supply unavailable. This is not an empty queue.');}finally{if(current())setBusy(false);}};void read();
  const unsub=client.subscribe(()=>{if(!current()){scope.current++;setEntries([]);setBusy(false);setNotice('Current session required.');}});
  return()=>{mounted=false;unsub();};
 },[client,mode,offset,reload]);
 return <aside className="calling-queue workspace-glass" aria-label="Calling supply"><div className="calling-queue-heading"><h2>Your next conversations</h2><button disabled={busy||disabled} onClick={()=>{scope.current++;setReload(v=>v+1);}}>Refresh</button></div>
 <div className="workspace-tabs" role="group" aria-label="Calling list"><button aria-pressed={mode==='prepared'} disabled={disabled} onClick={()=>changeMode('prepared')}>Prepared queue</button><button aria-pressed={mode==='retained'} disabled={disabled||client.current?.status!=='signed_in'||client.current.role!=='admin'} onClick={()=>changeMode('retained')}>Retained list</button></div>
 {notice?<p role="status">{notice}</p>:null}{!busy&&!notice&&entries.length===0?<p>No {mode==='prepared'?'prepared conversations':'retained observations'} on this page. Use Prospects to review current supply.</p>:null}<ul>{entries.map(entry=><li key={entry.subject.kind==='firm'?entry.subject.firmId:entry.subject.candidateId}><button disabled={disabled||busy} onClick={()=>onSelect(entry)}><strong>{entry.label}</strong><small>{entry.subject.kind==='firm'?'Prepared research · not call authority':'Raw observation · unverified'}</small></button></li>)}</ul>{mode==='retained'?<div className="calling-inline"><button disabled={disabled||busy||offset===0} onClick={()=>setOffset(v=>Math.max(0,v-50))}>Previous page</button><button disabled={disabled||busy||!more} onClick={()=>setOffset(v=>v+50)}>Next page</button></div>:null}</aside>;
}
