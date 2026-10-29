import {useCallback,useEffect,useRef,useState,type JSX} from 'react';
import type {CallingSubject} from '@fss/contracts';
import type {CallingWorkspaceProps} from './workspaceNavigation.ts';
import {CallingQueue,type CallingQueueEntry} from './CallingQueue.tsx';
import {CallingContext,type CallingContextData,type CallingContextEntry} from './CallingContext.tsx';
import {CallingSetup} from './CallingSetup.tsx';
import {CallingAudioTest} from './CallingAudioTest.tsx';
import {CallingSaveRecovery} from './CallingSaveRecovery.tsx';
import {CallingExecution} from './CallingExecution.tsx';
import type {CallingExecutionLink} from './CallingExecutionDispatch.ts';
import {CallingWrap} from './CallingWrap.tsx';
import {callingTarget} from './CallingPending.ts';
import './workspaceCalling.css';
/** Existing outcome workspace plus explicit browser calls, never automatic dialing. */
export function CallingWorkspace({client,selection,onSelectionChange,onAdvance,onOpenEmailDraft,onNavigate}:CallingWorkspaceProps):JSX.Element{
 const [entry,setEntry]=useState<CallingContextEntry|null>(null),[context,setContext]=useState<CallingContextData|null>(null),[paused,setPaused]=useState(false),[pending,setPending]=useState(false),[showList,setShowList]=useState(true),[generation,setGeneration]=useState(0),[signedIn,setSignedIn]=useState(client.current?.status==='signed_in');
 const [executionBlocked,setExecutionBlocked]=useState(false),[executionLink,setExecutionLink]=useState<CallingExecutionLink|null>(null);
 const [audioTestBlocked,setAudioTestBlocked]=useState(false);
 const executionRef=useRef(false);executionRef.current=executionBlocked||audioTestBlocked;
 const holdExecution=useCallback((value:boolean):void=>{setExecutionBlocked(value);},[]);
 const scope=useRef(0),title=useRef<HTMLHeadingElement>(null),entryRef=useRef<CallingContextEntry|null>(null),pendingRef=useRef(false);entryRef.current=entry;
 const select=useCallback((next:CallingContextEntry|null):void=>{scope.current++;entryRef.current=next;setContext(null);setExecutionLink(null);pendingRef.current=false;setPending(false);setEntry(next);setGeneration(v=>v+1);if(next)setShowList(false);},[]);
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
 const choose=(next:CallingQueueEntry):void=>{select(next.subject.kind==='firm'?{...next,label:'Selected company'}:next);onSelectionChange?.(next.subject);requestAnimationFrame(()=>title.current?.focus());};
 const advance=():void=>{if(pendingRef.current||executionRef.current)return;select(null);setShowList(true);onSelectionChange?.(null);onAdvance?.();};
 const subject:CallingSubject|null=entry?.subject??null;
 const version=scope.current;
 return <div className={`workspace-calling ${showList?'calling-list-open':''}`}><header className="workspace-page-head"><div><p className="workspace-eyebrow">One conversation at a time</p><h1 ref={title} tabIndex={-1}>Calling</h1><p>A sourced brief, your notes and a clear next step.</p></div><div className="calling-inline"><button onClick={()=>setShowList(v=>!v)}>{showList?'Focus view':'Choose from list'}</button><button aria-pressed={paused} onClick={()=>setPaused(v=>!v)}>{paused?'Resume session':'Pause session'}</button>{entry?<button disabled={pending||executionBlocked||audioTestBlocked} onClick={advance}>Next prospect →</button>:null}</div></header>
 {!signedIn?<p role="status">Sign in to review current Calling work.</p>:<><CallingSetup client={client}/><CallingAudioTest client={client} paused={paused||pending||executionBlocked} onBlockedChange={setAudioTestBlocked}/><CallingSaveRecovery client={client} localCandidateId={context?.prospect?.manualPhone?context.prospect.candidateId:undefined}/><p className="calling-session-state">{paused?'Session paused. Your next step can wait.':'Review current context before an explicit call or manual report.'}</p><div className="calling-layout">{showList||!entry?<CallingQueue client={client} onSelect={choose} disabled={false}/>:null}<section className="calling-focus"><CallingExecution client={client} context={context} paused={paused||pending||audioTestBlocked} isScopeCurrent={()=>scope.current===version} onBlockedChange={holdExecution} onLinkChange={setExecutionLink}/>{entry&&subject?<div className="calling-detail" key={`${callingTarget(subject)}:${generation}`}><CallingContext client={client} entry={entry} onReady={ready} onOpenPreparedFirm={(firmId,label)=>choose({subject:{kind:'firm',firmId},label})}/><CallingWrap client={client} subject={subject} context={context} paused={paused||executionBlocked||audioTestBlocked} executionLink={executionLink} isScopeCurrent={()=>scope.current===version} onPendingChange={held} {...(onOpenEmailDraft?{onOpenEmailDraft}:{})}/></div>:<section className="workspace-glass calling-empty"><h2>Your next conversation starts with context.</h2><p>Select prepared research or a retained observation. Unknown phone does not prevent an honest manual report.</p><button onClick={()=>onNavigate?.('prospects')}>Review prospect supply</button></section>}</section></div></>}
 </div>;
}
