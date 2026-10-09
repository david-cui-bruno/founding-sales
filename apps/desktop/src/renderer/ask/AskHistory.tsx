import {useEffect,useRef,useState} from 'react';
import {askHistoryPageSchema,type AskHistoryList} from '@fss/contracts';
import type {z} from 'zod';
export interface AskHistoryPorts {
 historyList(input:AskHistoryList):Promise<z.infer<typeof askHistoryPageSchema>>;
}
const status={pending:'Pending',complete:'Complete',unavailable:'Unavailable',unknown_acceptance:'Processing acceptance unknown',stale:'Stale',deleted:'Deleted'};
export function AskHistory({ports,enabled}:{ports:Partial<AskHistoryPorts>;enabled:boolean}){
 const [page,setPage]=useState<z.infer<typeof askHistoryPageSchema>|null>(null);
 const [notice,setNotice]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const epoch=useRef(0);
 useEffect(()=>()=>{epoch.current++;},[]);
 async function list(cursor?:AskHistoryList['cursor']){
  if(!enabled||!ports.historyList||busy)return;
  const captured=++epoch.current;
  setPage(null);setBusy(true);setNotice(null);
  try{
   const fresh=askHistoryPageSchema.parse(await ports.historyList({limit:20,...(cursor===undefined?{}:{cursor})}));
   if(captured===epoch.current)setPage(fresh);
  }catch{if(captured===epoch.current){setPage(null);setNotice('Private history is unavailable. Read current access again.');}}
  finally{if(captured===epoch.current)setBusy(false);}
 }
 return <section aria-label='Private Ask history'>
  <h2>Private history</h2>
  <p>Saved investigations are dated snapshots. Opening one checks current evidence.</p>
  <button disabled={!enabled||!ports.historyList||busy} onClick={()=>{void list();}}>Read private history</button>
  {notice!==null&&<p role='status'>{notice}</p>}
  {page?.items.length===0&&<p>No saved investigations on this page.</p>}
  {page?.items.map(item=><article key={item.requestId}>
   <h3>{item.title??'Unavailable investigation'}</h3>
   <time dateTime={item.createdAt}>{item.createdAt}</time>
   <p>{status[item.state]}{item.pinned?' · Pinned':''}</p>
   {item.question!==null&&<p>{item.question}</p>}
  </article>)}
  {page?.nextCursor!=null&&<button disabled={!enabled||busy} onClick={()=>{void list(page.nextCursor??undefined);}}>Older investigations</button>}
 </section>;
}
