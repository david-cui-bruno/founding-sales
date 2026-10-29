import {useEffect,useLayoutEffect,useRef,useState,type JSX} from 'react';
import {socialPublicThreadListSchema,socialPublicThreadReadSchema,type SocialPublicThreadMetadata,type SocialPublicThreadView} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
const unavailable=(thread:SocialPublicThreadMetadata):SocialPublicThreadMetadata=>({threadId:thread.threadId,revision:thread.revision,
 capturedAt:thread.capturedAt,expiresAt:thread.expiresAt,availability:'unavailable',reason:'expired'});
/** Public retained originals only. Nothing is fetched from a platform or sent here. */
export function BrowserSocialConversations({client}:{client:BrowserClient}):JSX.Element{
 const binding=useRef({client,key:0});if(binding.current.client!==client)binding.current={client,key:binding.current.key+1};
 return <PublicThreadSession key={binding.current.key} client={client}/>;
}
function PublicThreadSession({client}:{client:BrowserClient}):JSX.Element|null{
 const [epoch,setEpoch]=useState(client.epoch),[signedIn,setSignedIn]=useState(client.current?.status==='signed_in');
 const [threads,setThreads]=useState<SocialPublicThreadMetadata[]>([]),[cursor,setCursor]=useState<string|null>(null);
 const [selected,setSelected]=useState<SocialPublicThreadView|null>(null),[busy,setBusy]=useState(false);
 const [notice,setNotice]=useState('Read retained public threads. No platform acquisition is performed.');
 const owner=useRef(0),lock=useRef(false),scope=useRef(client);scope.current=client;
 useLayoutEffect(()=>{
  const clear=()=>{owner.current++;lock.current=false;setBusy(false);setThreads([]);setCursor(null);setSelected(null);setEpoch(client.epoch);setNotice('Public-thread view cleared. Read retained threads again.');};
  clear();let observed=client.epoch;const requestOwner=owner;
  const stop=client.subscribe(()=>{setSignedIn(client.current?.status==='signed_in');if(observed!==client.epoch||client.current?.status!=='signed_in'){observed=client.epoch;clear();}});
  return ()=>{requestOwner.current++;lock.current=false;stop();};
 },[client]);
 useEffect(()=>{
  const deadlines=[...threads.filter(thread=>thread.availability==='available').map(thread=>Date.parse(thread.expiresAt)),
   ...(selected?.availability==='available'?[Date.parse(selected.expiresAt)]:[])];
  if(!deadlines.length)return;
  const timer=setTimeout(()=>{
   setThreads(items=>items.map(thread=>thread.availability==='available'&&Date.parse(thread.expiresAt)<=Date.now()?unavailable(thread):thread));
   setSelected(thread=>thread?.availability==='available'&&Date.parse(thread.expiresAt)<=Date.now()?null:thread);
  },Math.min(2147483647,Math.max(0,Math.min(...deadlines)-Date.now())));
  return ()=>clearTimeout(timer);
 },[threads,selected]);
 const read=async(thread?:SocialPublicThreadMetadata,afterId?:string):Promise<void>=>{
  if(lock.current||client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  lock.current=true;setBusy(true);setSelected(null);const token=++owner.current,generation=client.epoch;
  const current=()=>scope.current===client&&owner.current===token&&client.isCurrent(generation);
  setNotice('Reading retained public evidence…');
  try{
   if(thread){
    const result=await client.request('/social/threads/read',socialPublicThreadReadSchema,{threadId:thread.threadId,expectedRevision:thread.revision},()=>{if(!current())throw Error('Scope changed');});
    if(!current())return;
    if(result.thread.threadId!==thread.threadId||result.thread.revision!==thread.revision||result.thread.availability!=='available'||Date.parse(result.thread.expiresAt)<=Date.now()){
     setNotice('Thread changed, expired or unavailable. Read the retained list again.');return;
    }
    setSelected(result.thread);setNotice('Retained public snapshot. Coverage and attribution gaps remain explicit.');
   }else{
    setThreads([]);setCursor(null);
    const result=await client.request('/social/threads/list',socialPublicThreadListSchema,afterId?{afterId}:{},()=>{if(!current())throw Error('Scope changed');});
    if(!current())return;
    setThreads(result.threads.map(item=>item.availability==='available'&&Date.parse(item.expiresAt)<=Date.now()?unavailable(item):item));setCursor(result.nextAfterId);
    setNotice(result.threads.length?'Select an exact retained revision to open it.':'No retained public threads. No platform content has been acquired by this screen.');
   }
  }catch{if(current()){setSelected(null);setNotice('Public thread unavailable or access refused. Nothing was retried.');}}
  finally{if(current()){lock.current=false;setBusy(false);}}
 };
 if(!signedIn||client.current?.status!=='signed_in'||client.current.role!=='admin'||epoch!==client.epoch||scope.current!==client)return null;
 return <section aria-label="Retained public conversations">
  <h2>Public conversations</h2><p>Retained LinkedIn public-web post/thread snapshots. Coverage is partial or unknown. These are not DMs or private/group discussions.</p>
  <button type="button" disabled={busy} onClick={()=>{void read();}}>Read retained public threads</button>
  {cursor?<button type="button" disabled={busy} onClick={()=>{void read(undefined,cursor);}}>Next retained threads</button>:null}
  <p role="status">{notice}</p>
  <ul>{threads.map(thread=><li key={thread.threadId}>
   Captured {thread.capturedAt} · Expires {thread.expiresAt} · Revision {thread.revision}
   {thread.availability==='available'?<><p>{thread.messageCount} retained messages · Coverage {thread.coverage}</p><button type="button" aria-label={`Open snapshot ${thread.threadId}`} disabled={busy||Date.parse(thread.expiresAt)<=Date.now()} onClick={()=>{void read(thread);}}>Open snapshot</button></>:<p>Unavailable: {thread.reason}</p>}
  </li>)}</ul>
  {selected?.availability==='available'?<article aria-label="Opened public thread">
   <h3>Retained public original</h3><p>Source: {selected.snapshot.url}</p><p>Captured {selected.capturedAt} · Expires {selected.expiresAt} · Coverage {selected.snapshot.coverage}</p>
   <ol>{selected.snapshot.messages.map(message=><li key={message.messageId}>
    <p>Message {message.messageId} · {message.parent.kind==='root'?'Observed root':message.parent.kind==='retained'?`Retained parent ${message.parent.messageId}`:`Parent unavailable${message.parent.messageId?` (${message.parent.messageId})`:''}`}</p>
    <p>{message.author.status==='known'?`Observed author: ${message.author.displayName}`:'Author unknown'} · {message.publishedAt.status==='known'?`Published ${message.publishedAt.at}`:'Publication time unknown'} · Text coverage {message.textCoverage}</p>
    <p style={{whiteSpace:'pre-wrap'}}>{message.text}</p>
   </li>)}</ol>
  </article>:null}
  <p>No acquisition, replies, model processing, account connection or publication is performed here.</p>
 </section>;
}
