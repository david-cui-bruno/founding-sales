import {useCallback,useEffect,useRef,useState,type JSX} from 'react';
import type {CallingSubject} from '@fss/contracts';
import type {CallingWorkspaceProps} from './workspaceNavigation.ts';
import {CallingQueue,type CallingQueueEntry} from './CallingQueue.tsx';
import {CallingContext,type CallingContextData} from './CallingContext.tsx';
import {CallingWrap} from './CallingWrap.tsx';
import {callingTarget} from './CallingPending.ts';
import './workspaceCalling.css';
/** Local selection and pause only, no dialer, reservation, sending or hidden retry. */
export function CallingWorkspace({client,selection,onSelectionChange,onAdvance,onOpenEmailDraft,onNavigate}:CallingWorkspaceProps):JSX.Element{
 const [entry,setEntry]=useState<CallingQueueEntry|null>(null),[context,setContext]=useState<CallingContextData|null>(null),[paused,setPaused]=useState(false),[pending,setPending]=useState(false),[showList,setShowList]=useState(true),[generation,setGeneration]=useState(0),[signedIn,setSignedIn]=useState(client.current?.status==='signed_in');
 const scope=useRef(0),title=useRef<HTMLHeadingElement>(null),entryRef=useRef<CallingQueueEntry|null>(null),pendingRef=useRef(false);entryRef.current=entry;
 const select=useCallback((next:CallingQueueEntry|null):void=>{scope.current++;entryRef.current=next;setContext(null);pendingRef.current=false;setPending(false);setEntry(next);setGeneration(v=>v+1);if(next)setShowList(false);},[]);
 useEffect(()=>{const old=entryRef.current?.subject;if(selection&&(!old||JSON.stringify(old)!==JSON.stringify(selection)))select({subject:selection,label:selection.kind==='firm'?'Selected Firm':'Selected retained observation'});else if(selection===null&&old)select(null);},[selection,select]);
 useEffect(()=>{let epoch=client.epoch;return client.subscribe(()=>{const current=client.current?.status==='signed_in';setSignedIn(current);if(epoch!==client.epoch||!current){epoch=client.epoch;select(null);setPaused(false);}});},[client,select]);
 const ready=useCallback((data:CallingContextData|null):void=>{if(data===null||data.entry===entryRef.current)setContext(data);},[]);
 const held=useCallback((value:boolean):void=>{pendingRef.current=value;setPending(value);},[]);
 const choose=(next:CallingQueueEntry):void=>{select(next);onSelectionChange?.(next.subject);requestAnimationFrame(()=>title.current?.focus());};
 const advance=():void=>{if(pendingRef.current)return;select(null);setShowList(true);onSelectionChange?.(null);onAdvance?.();};
 const subject:CallingSubject|null=entry?.subject??null;
 const version=scope.current;
 return <div className={`workspace-calling ${showList?'calling-list-open':''}`}><header className="workspace-page-head"><div><p className="workspace-eyebrow">One conversation at a time</p><h1 ref={title} tabIndex={-1}>Calling</h1><p>A sourced brief, your notes and a clear next step.</p></div><div className="calling-inline"><button onClick={()=>setShowList(v=>!v)}>{showList?'Focus view':'Choose from list'}</button><button aria-pressed={paused} onClick={()=>setPaused(v=>!v)}>{paused?'Resume session':'Pause session'}</button>{entry?<button disabled={pending} onClick={advance}>Next prospect →</button>:null}</div></header>
 {!signedIn?<p role="status">Sign in to review current Calling work.</p>:<><p className="calling-session-state">{paused?'Session paused. Your next step can wait.':'Ready for manual review. No call is placed here.'}</p><div className="calling-layout">{showList||!entry?<CallingQueue client={client} onSelect={choose} disabled={false}/>:null}<section className="calling-focus">{entry&&subject?<div key={`${callingTarget(subject)}:${generation}`}><CallingContext client={client} entry={entry} onReady={ready}/><CallingWrap client={client} subject={subject} context={context} paused={paused} isScopeCurrent={()=>scope.current===version} onPendingChange={held} {...(onOpenEmailDraft?{onOpenEmailDraft}:{})}/></div>:<section className="workspace-glass calling-empty"><h2>Your next conversation starts with context.</h2><p>Select prepared research or a retained observation. Unknown phone does not prevent an honest manual report.</p><button onClick={()=>onNavigate?.('prospects')}>Review prospect supply</button></section>}</section></div></>}
 </div>;
}
