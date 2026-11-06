import {useCallback,useEffect,useRef,useState,type JSX,type ReactNode} from 'react';
import type {CallingSubject} from '@fss/contracts';
import type {ProspectsWorkspaceProps} from './workspaceNavigation.ts';
import {CallingQueue,type CallingQueueEntry} from './CallingQueue.tsx';
import {CallingContext,type CallingContextData,type CallingContextEntry} from './CallingContext.tsx';
import {CallingSaveRecovery} from './CallingSaveRecovery.tsx';
import {CallingExecution} from './CallingExecution.tsx';
import type {CallingExecutionLink} from './CallingExecutionDispatch.ts';
import {CallingWrap} from './CallingWrap.tsx';
import {callingTarget} from './CallingPending.ts';
import './workspaceCalling.css';
import { useWorkspaceNavigation } from './WorkspaceNavigationGuard.tsx';
import { ProspectActivity } from './ProspectActivity.tsx';
/** Existing outcome workspace plus explicit browser calls, never automatic dialing. */
export function ProspectConversation({client,selection,onSelectionChange,onAdvance,onOpenEmailDraft,onNavigate,toolbar,researchList,researchBrief,researchOverview,canAdvance=false}:ProspectsWorkspaceProps&{toolbar?:ReactNode;researchList?:ReactNode;researchBrief?:ReactNode;researchOverview?:ReactNode;canAdvance?:boolean}):JSX.Element{
 const [entry,setEntry]=useState<CallingContextEntry|null>(null),[context,setContext]=useState<CallingContextData|null>(null),[paused,setPaused]=useState(false),[pending,setPending]=useState(false),[showList,setShowList]=useState(true),[generation,setGeneration]=useState(0),[signedIn,setSignedIn]=useState(client.current?.status==='signed_in');
 const [executionBlocked,setExecutionBlocked]=useState(false),[executionLink,setExecutionLink]=useState<CallingExecutionLink|null>(null);
 const [detailTab,setDetailTab]=useState<'brief'|'sources'|'activity'>('brief'),[activityRefresh,setActivityRefresh]=useState(0);
 const recorded=useCallback(()=>setActivityRefresh(value=>value+1),[]);
 const canLeave=useWorkspaceNavigation();
 const executionRef=useRef(false);executionRef.current=executionBlocked;
 const holdExecution=useCallback((value:boolean):void=>{executionRef.current=value;setExecutionBlocked(value);},[]);
 const scope=useRef(0),title=useRef<HTMLHeadingElement>(null),entryRef=useRef<CallingContextEntry|null>(null),pendingRef=useRef(false);entryRef.current=entry;
 const callbacks=useRef({onSelectionChange,onAdvance});callbacks.current={onSelectionChange,onAdvance};
 const queueAdvance=useRef<(()=>void)|null>(null),[queueCanAdvance,setQueueCanAdvance]=useState(false);
 const receiveAdvance=useCallback((next:(()=>void)|null):void=>{queueAdvance.current=next;setQueueCanAdvance(next!==null);},[]);
 const select=useCallback((next:CallingContextEntry|null):void=>{scope.current++;entryRef.current=next;setContext(null);setExecutionLink(null);pendingRef.current=false;setPending(false);setEntry(next);setGeneration(v=>v+1);setDetailTab('brief');if(next)setShowList(false);},[]);
 useEffect(()=>{
  const old=entryRef.current;
  if(selection){
   const {prospectPage,...subject}=selection;
   if(!old||JSON.stringify(old.subject)!==JSON.stringify(subject)||JSON.stringify(old.prospectPage)!==JSON.stringify(prospectPage))select({subject,label:selection.kind==='firm'?'Selected Firm':'Selected retained observation',...(prospectPage?{prospectPage}:{})});
  }else if(selection===null&&old)select(null);
 },[selection,select]);
 useEffect(()=>{let epoch=client.epoch;return client.subscribe(()=>{const current=client.current?.status==='signed_in';setSignedIn(current);if(epoch!==client.epoch||!current){epoch=client.epoch;select(null);setPaused(false);}});},[client,select]);
 const ready=useCallback((data:CallingContextData|null):void=>{if(data===null||data.entry===entryRef.current)setContext(data);},[]);
 const held=useCallback((value:boolean):void=>{pendingRef.current=value;setPending(value);},[]);
 const choose=useCallback((next:CallingQueueEntry):void=>{
  if(client.current?.status!=='signed_in'||!canLeave())return;
  select(next.subject.kind==='firm'?{...next,label:'Selected company'}:next);
  callbacks.current.onSelectionChange?.(next.subject);
  requestAnimationFrame(()=>title.current?.focus());
 },[canLeave,client,select]);
 const advance=():void=>{
  if(pendingRef.current||executionRef.current)return;
  if(callbacks.current.onAdvance)callbacks.current.onAdvance();
  else queueAdvance.current?.();
 };
 const subject:CallingSubject|null=entry?.subject??null;
 const version=scope.current;
 const isScopeCurrent=useCallback(()=>scope.current===version,[version]);
 return <div className={`workspace-calling ${showList?'calling-list-open':''}`}>
  <header className="workspace-page-head"><div><p className="workspace-eyebrow">One company, one clear next step</p>
   <h1 ref={title} tabIndex={-1}>Prospects</h1><p>Research, conversation and follow-through in one workspace.</p>
  </div><div className="calling-inline">
   <button className="workspace-mobile-back" onClick={()=>setShowList(value=>!value)}>{showList?'Focus company':'Choose company'}</button>
   <button aria-pressed={paused} onClick={()=>setPaused(value=>!value)}>{paused?'Resume session':'Pause session'}</button>
   <button onClick={()=>onNavigate?.('settings')}>Calling settings</button>
   {entry?<button disabled={pending||executionBlocked||(onAdvance?!canAdvance:!queueCanAdvance)} onClick={advance}>Next prospect →</button>:null}
  </div></header>
  {toolbar}
  {!signedIn?<p role="status">Sign in to review current prospects.</p>:<>
   <CallingSaveRecovery client={client} localCandidateId={context?.prospect?.manualPhone?context.prospect.candidateId:undefined}/>
   {paused?<p className="calling-session-state" role="status">Session paused. Current work remains here.</p>:null}
   <div className="calling-layout">
    {researchList===undefined?<CallingQueue client={client} onSelect={choose} selected={subject} onAdvanceReady={receiveAdvance} disabled={pending}/>:<aside className="prospects-research-list" aria-label="Company research list">{researchList}</aside>}
    <section className="calling-focus">
     <CallingExecution client={client} context={context} paused={paused||pending} isScopeCurrent={isScopeCurrent} onBlockedChange={holdExecution} onLinkChange={setExecutionLink}/>
     {entry&&subject?<div className="calling-detail" key={`${callingTarget(subject)}:${generation}`}>
      <nav className="prospect-detail-tabs" aria-label="Company detail views">{(['brief','sources','activity'] as const).map(tab=><button key={tab} aria-pressed={detailTab===tab} onClick={()=>setDetailTab(tab)}>{tab==='brief'?'Brief':tab==='sources'?'Sources':'Activity'}</button>)}</nav>
      <div hidden={detailTab==='activity'}>{detailTab==='sources'?researchBrief:researchOverview}</div>
      <div hidden={detailTab==='activity'}><CallingContext client={client} entry={entry} onReady={ready} showSources={detailTab==='sources'} hideIdentity={!!researchOverview} onOpenPreparedFirm={(firmId,label)=>choose({subject:{kind:'firm',firmId},label})}/></div>
      {detailTab==='activity'?<ProspectActivity key={activityRefresh} client={client} context={context} isScopeCurrent={isScopeCurrent}/>:null}
      <CallingWrap client={client} subject={subject} context={context} paused={paused||executionBlocked} executionLink={executionLink} isScopeCurrent={isScopeCurrent} onPendingChange={held} onRecorded={recorded} {...(onOpenEmailDraft?{onOpenEmailDraft}:{})}/>
     </div>:<section className="workspace-glass calling-empty"><h2>Select a company to begin.</h2><p>Read its sources, prepare the conversation and record what actually happened. No call starts automatically.</p></section>}
    </section>
   </div>
  </>}
 </div>;
}
