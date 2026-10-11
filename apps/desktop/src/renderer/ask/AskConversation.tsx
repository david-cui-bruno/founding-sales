import {askAgentScopeSchema} from '@fss/contracts';
import {useEffect,useRef,useState} from 'react';
import type {z} from 'zod';
import type {AskAgentScope,askSessionCreatePayloadSchema,askSessionIdentitySchema,askSessionReadSchema,askSessionViewSchema,askSessionTurnPayloadSchema,askSessionTurnAcknowledgmentSchema,askSessionChangePayloadSchema,askSessionListSchema,askSessionPageSchema} from '@fss/contracts';
import {AskAnswer,type AskAnswerPorts} from './AskAnswer.tsx';
import type {AskFollowOnPorts} from './AskFollowOn.tsx';
export interface AskConversationPorts {
 sessionCreate(input:z.infer<typeof askSessionCreatePayloadSchema>):Promise<z.infer<typeof askSessionIdentitySchema>>;
 sessionRead(input:z.infer<typeof askSessionReadSchema>):Promise<z.infer<typeof askSessionViewSchema>>;
 sessionTurn(input:z.infer<typeof askSessionTurnPayloadSchema>):Promise<z.infer<typeof askSessionTurnAcknowledgmentSchema>>;
 sessionChange(input:z.infer<typeof askSessionChangePayloadSchema>):Promise<z.infer<typeof askSessionIdentitySchema>>;
 sessionList(input:z.infer<typeof askSessionListSchema>):Promise<z.infer<typeof askSessionPageSchema>>;
}
type View=z.infer<typeof askSessionViewSchema>;
function scopeLabel(scope:AskAgentScope|null){if(scope===null)return 'unavailable';if(scope.kind==='business')return 'approved business history';if(scope.kind==='selected')return `${scope.sources.length} selected sources`;return `${scope.kind} ${scope.kind==='firm'?scope.firmId:scope.personId}`;}
const inclusiveToDate=(bound:string|undefined)=>bound===undefined?'':new Date(Date.parse(bound)-1).toISOString().slice(0,10);
const exclusiveNextDay=(day:string)=>new Date(Date.parse(`${day}T00:00:00.000Z`)+86400000).toISOString();
export function AskConversation({ports,enabled,initialScope={kind:'business'}}:{ports:Partial<AskConversationPorts>&Partial<AskAnswerPorts>&Partial<AskFollowOnPorts>;enabled:boolean;initialScope?:AskAgentScope}){
 const [current,setCurrent]=useState<View|null>(null),[history,setHistory]=useState<View[]>([]),[question,setQuestion]=useState(''),[title,setTitle]=useState(''),[notice,setNotice]=useState<string|null>(null),[busy,setBusy]=useState(false),[expand,setExpand]=useState(false);
 const [fromDate,setFromDate]=useState(''),[toDate,setToDate]=useState(''),[datePreview,setDatePreview]=useState<AskAgentScope|null>(null);
 const epoch=useRef(0);useEffect(()=>()=>{epoch.current++;},[]);
 async function run(action:()=>Promise<void>){const captured=++epoch.current;setBusy(true);setNotice(null);try{await action();}catch{if(captured===epoch.current){setCurrent(null);setHistory([]);setQuestion('');setTitle('');setNotice('Conversation unavailable. Read current access again.');}}finally{if(captured===epoch.current)setBusy(false);}}
 async function reopen(sessionId:string,captured:number){if(!ports.sessionRead)return;const fresh=await ports.sessionRead({sessionId});if(captured!==epoch.current)return;if(fresh.sessionId!==sessionId)throw Error('session_changed');setCurrent(fresh);setTitle(fresh.title??'');setExpand(false);setFromDate(fresh.scope?.from?.slice(0,10)??'');setToDate(inclusiveToDate(fresh.scope?.to));setDatePreview(null);}
 async function create(){if(!ports.sessionCreate||!ports.sessionRead)return;const captured=epoch.current;const next=await ports.sessionCreate({scope:initialScope});if(captured!==epoch.current)return;setQuestion('');await reopen(next.sessionId,captured);}
 async function change(action:z.infer<typeof askSessionChangePayloadSchema>['action']){if(!current||!ports.sessionChange)return;const captured=epoch.current;const ack=await ports.sessionChange({sessionId:current.sessionId,version:current.version,action});if(captured!==epoch.current)return;if(action.kind==='delete'){setCurrent(null);setHistory(previous=>previous.filter(item=>item.sessionId!==ack.sessionId));setTitle('');return;}await reopen(ack.sessionId,captured);}
 async function ask(){if(!current||!ports.sessionTurn||!question.trim())return;const captured=epoch.current;const ack=await ports.sessionTurn({sessionId:current.sessionId,version:current.version,question:question.trim()});if(captured!==epoch.current)return;setQuestion('');await reopen(ack.sessionId,captured);if(captured===epoch.current)setNotice('Question saved. Processing may require configuration.');}
 async function list(){if(!ports.sessionList)return;const captured=epoch.current;const next=await ports.sessionList({limit:20});if(captured===epoch.current){setHistory(next.sessions);if(next.truncated)setNotice('More conversations exist than this page shows.');}}
 if(!ports.sessionCreate)return null;
 return <section aria-label='Conversations'>
  <button disabled={!enabled||busy} onClick={()=>{void run(create);}}>New conversation</button>
  <button disabled={!enabled||busy||!ports.sessionList} onClick={()=>{void run(list);}}>Read conversations</button>
  {notice&&<p role='status'>{notice}</p>}
  {history.map(item=><button key={item.sessionId} disabled={!enabled||busy} onClick={()=>{void run(()=>reopen(item.sessionId,epoch.current));}}>{item.title??'Untitled conversation'} · {item.createdAt}{item.pinned?' · Pinned':''}</button>)}
  {current?.state==='active'&&<div>
   <p>Scope: {scopeLabel(current.scope)}</p><p>Coverage: {current.coverage}. Earlier answers are dated observations.</p>
   {current.scope?.from&&<p>From {current.scope.from}</p>}{current.scope?.to&&<p>Before {current.scope.to}</p>}
   {current.scope?.kind!=='business'&&<button disabled={!enabled||busy||!ports.sessionChange} onClick={()=>setExpand(true)}>Expand to business history</button>}
   {expand&&<div><p>This conversation will search approved business history beyond its current record. Other conversations keep their scope.</p><button disabled={!enabled||busy} onClick={()=>{void run(()=>change({kind:'scope',scope:{kind:'business'},confirmExpansion:true}));}}>Confirm broader scope</button><button onClick={()=>setExpand(false)}>Keep current scope</button></div>}
   <label>Conversation from date (UTC)<input aria-label='Conversation from date (UTC)' type='date' value={fromDate} disabled={!enabled||busy} onChange={event=>{setFromDate(event.target.value);setDatePreview(null);}}/></label>
   <label>Conversation until date (UTC)<input aria-label='Conversation until date (UTC)' type='date' value={toDate} disabled={!enabled||busy} onChange={event=>{setToDate(event.target.value);setDatePreview(null);}}/></label>
   <button disabled={!enabled||busy||!ports.sessionChange||current.scope===null} onClick={()=>{if(!current.scope)return;const base={...current.scope};delete base.from;delete base.to;const parsed=askAgentScopeSchema.safeParse({...base,...fromDate?{from:`${fromDate}T00:00:00.000Z`}:{},...toDate?{to:exclusiveNextDay(toDate)}:{}});if(parsed.success){setDatePreview(parsed.data);setNotice(null);}else setNotice('Choose an ordered date range.');}}>Preview conversation date range</button>
   {datePreview&&<div><p>This conversation will use {scopeLabel(datePreview)} from {datePreview.from??'the beginning'} through {datePreview.to?`${inclusiveToDate(datePreview.to)} (UTC)`:'the latest approved evidence'}. Earlier wider context is excluded when narrowing; removing a date can expand this session.</p><button disabled={!enabled||busy} onClick={()=>{void run(()=>change({kind:'scope',scope:datePreview,confirmExpansion:true}));}}>Confirm conversation date range</button><button onClick={()=>setDatePreview(null)}>Keep current dates</button></div>}
   {initialScope.kind!=='business'&&<button disabled={!enabled||busy||!ports.sessionChange} onClick={()=>{void run(()=>change({kind:'scope',scope:initialScope,confirmExpansion:false}));}}>Use selected record scope</button>}
   <label>Conversation title<input aria-label='Conversation title' value={title} maxLength={100} onChange={event=>setTitle(event.target.value)}/></label>
   <button disabled={!enabled||busy||!title.trim()||!ports.sessionChange} onClick={()=>{void run(()=>change({kind:'rename',title:title.trim()}));}}>Rename conversation</button>
   <button disabled={!enabled||busy||!ports.sessionChange} onClick={()=>{void run(()=>change({kind:'pin',pinned:!current.pinned}));}}>{current.pinned?'Unpin conversation':'Pin conversation'}</button>
   <button disabled={!enabled||busy||!ports.sessionChange} onClick={()=>{void run(()=>change({kind:'delete'}));}}>Delete conversation</button>
   {current.turns.map(turn=><article key={turn.requestId}><time dateTime={turn.createdAt}>{turn.createdAt}</time><AskAnswer ports={ports} enabled={enabled} existingRequestId={turn.requestId}/></article>)}
   <label>Ask a question<textarea aria-label='Ask a question' value={question} maxLength={300} onChange={event=>setQuestion(event.target.value)}/></label>
   <button disabled={!enabled||busy||!question.trim()||current.scope===null||!ports.sessionTurn} onClick={()=>{void run(ask);}}>Ask question</button>
   <button disabled={!enabled||busy} onClick={()=>{void run(()=>reopen(current.sessionId,epoch.current));}}>Refresh conversation</button>
  </div>}
 </section>;
}
