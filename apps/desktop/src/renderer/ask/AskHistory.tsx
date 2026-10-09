import type {AskFollowOnPorts} from "./AskFollowOn.tsx";
import {useCallback,useEffect,useRef,useState} from 'react';
import {askHistoryPageSchema,askHistoryChangedSchema,type askHistoryChangePayloadSchema,type AskHistoryList} from '@fss/contracts';
import type {z} from 'zod';
import {AskAnswer,type AskAnswerPorts} from './AskAnswer.tsx';
export interface AskHistoryPorts {
 historyChange(input:z.infer<typeof askHistoryChangePayloadSchema>):Promise<z.infer<typeof askHistoryChangedSchema>>;
 historyList(input:AskHistoryList):Promise<z.infer<typeof askHistoryPageSchema>>;
}
type HistoryItem=z.infer<typeof askHistoryPageSchema>['items'][number];
function HistoryEditing({item,enabled,change}:{item:HistoryItem;enabled:boolean;change:(action:z.infer<typeof askHistoryChangePayloadSchema>['action'])=>void}){
 const [title,setTitle]=useState(item.title??'');
 return <div><label>Investigation title<input aria-label='Investigation title' maxLength={100} value={title} onChange={event=>setTitle(event.target.value)}/></label>
 <button disabled={!enabled||!title.trim()||title.trim().length>100} onClick={()=>change({kind:'rename',title:title.trim()})}>Save title</button><button disabled={!enabled} onClick={()=>change({kind:'pin',pinned:!item.pinned})}>{item.pinned?'Unpin investigation':'Pin investigation'}</button></div>;
}
function HistoryDelete({enabled,remove}:{enabled:boolean;remove:()=>void}){
 const [confirmed,setConfirmed]=useState(false);
 return <div><label><input type='checkbox' checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>Confirm deleting this investigation</label><button disabled={!enabled||!confirmed} onClick={remove}>Delete investigation</button><p>Deleting history preserves separately saved tasks, notes and preference proposals.</p></div>;
}
const status={pending:'Pending',complete:'Complete',unavailable:'Unavailable',unknown_acceptance:'Processing acceptance unknown',stale:'Stale',deleted:'Deleted'};
export function AskHistory({ports,enabled}:{ports:Partial<AskHistoryPorts>&Partial<AskAnswerPorts>&Partial<AskFollowOnPorts>;enabled:boolean}){
 const [page,setPage]=useState<z.infer<typeof askHistoryPageSchema>|null>(null);
 const [opened,setOpened]=useState<{requestId:string;epoch:number}|null>(null);
 const [notice,setNotice]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const epoch=useRef(0);
 const clearPrivateList=useCallback(()=>setPage(null),[]);
 useEffect(()=>()=>{epoch.current++;},[]);
 async function list(cursor?:AskHistoryList['cursor']){
  if(!enabled||!ports.historyList||busy)return;
  const captured=++epoch.current;
  setPage(null);setOpened(null);setBusy(true);setNotice(null);
  try{
   const fresh=askHistoryPageSchema.parse(await ports.historyList({limit:20,...(cursor===undefined?{}:{cursor})}));
   if(captured===epoch.current)setPage(fresh);
  }catch{if(captured===epoch.current){setPage(null);setNotice('Private history is unavailable. Read current access again.');}}
  finally{if(captured===epoch.current)setBusy(false);}
 }
 async function change(item:HistoryItem,action:z.infer<typeof askHistoryChangePayloadSchema>['action']){
  if(!enabled||!ports.historyChange||!ports.historyList||busy)return;
  const captured=++epoch.current;
  setPage(null);setOpened(null);setBusy(true);setNotice(null);
  try{
   const receipt=askHistoryChangedSchema.parse(await ports.historyChange({requestId:item.requestId,expectedRevision:item.historyRevision,action}));
   if(captured!==epoch.current)return;
   if(receipt.requestId!==item.requestId||receipt.historyRevision<=item.historyRevision)throw new Error('changed_history');
   const fresh=askHistoryPageSchema.parse(await ports.historyList({limit:20}));
   if(captured===epoch.current)setPage(fresh);
  }catch{if(captured===epoch.current)setNotice('History change could not be confirmed. Read current history before trying again.');}
  finally{if(captured===epoch.current)setBusy(false);}
 }
 return <section aria-label='Private Ask history'>
  <h2>Private history</h2>
  <p>Saved investigations are dated snapshots. Opening one checks current evidence.</p>
  <button disabled={!enabled||!ports.historyList||busy} onClick={()=>{void list();}}>Read private history</button>
  {notice!==null&&<p role='status'>{notice}</p>}
  {page?.items.length===0&&<p>No saved investigations on this page.</p>}
  {page?.items.map(item=><article key={item.requestId}>
   <h3>{item.title??(item.question!==null?'Saved investigation':'Unavailable investigation')}</h3>
   <time dateTime={item.createdAt}>{item.createdAt}</time>
   <p>{status[item.state]}{item.pinned?' · Pinned':''}</p>
   {item.question!==null&&<p>{item.question}</p>}
   {item.question!==null&&item.state!=='stale'&&item.state!=='deleted'&&<HistoryEditing key={`${item.requestId}:${item.historyRevision}`} item={item} enabled={enabled&&!busy&&ports.historyChange!==undefined} change={action=>{void change(item,action);}}/>}
   {item.state!=='deleted'&&<HistoryDelete key={`delete:${item.requestId}:${item.historyRevision}`} enabled={enabled&&!busy&&ports.historyChange!==undefined} remove={()=>{void change(item,{kind:'delete'});}}/>}
   <button disabled={!enabled||busy||!ports.answerRead} onClick={()=>setOpened({requestId:item.requestId,epoch:++epoch.current})}>Open investigation</button>
  </article>)}
  {opened!==null&&<AskAnswer key={`${opened.requestId}:${opened.epoch}`} ports={ports} enabled={enabled} existingRequestId={opened.requestId} onUnavailable={clearPrivateList}/> }
  {page?.nextCursor!=null&&<button disabled={!enabled||busy} onClick={()=>{void list(page.nextCursor??undefined);}}>Older investigations</button>}
 </section>;
}
