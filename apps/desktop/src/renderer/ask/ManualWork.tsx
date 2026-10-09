import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import {askActionReadSchema,askActionPageSchema,askActionChangedSchema} from '@fss/contracts';
import {manualWorkPorts} from './manualWorkPorts.ts';
import type {z} from 'zod';
import type {askActionChangePayloadSchema} from '@fss/contracts';
export interface ManualWorkPorts {
 actionRead(input:z.infer<typeof askActionReadSchema>):Promise<z.infer<typeof askActionPageSchema>>;
 actionChange(input:z.infer<typeof askActionChangePayloadSchema>):Promise<z.infer<typeof askActionChangedSchema>>;
}
type Props={scope:z.infer<typeof askActionReadSchema>['scope'];ports?:Partial<ManualWorkPorts>;privacyKey:string|object|null;enabled:boolean};
export function ManualWork({scope,ports=manualWorkPorts,privacyKey,enabled}:Props){
 const [page,setPage]=useState<z.infer<typeof askActionPageSchema>|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState<string|null>(null);
 const epoch=useRef(0),scopeIdentity=JSON.stringify(scope),readPort=ports.actionRead;
 const invalidate=useCallback(()=>++epoch.current,[]);
 const load=useCallback(async(afterId?:string)=>{
  const captured=invalidate();setPage(null);setBusy(true);setNotice(null);
  try{
   if(!enabled||!readPort)throw new Error('unavailable');
   const input=askActionReadSchema.parse({scope:JSON.parse(scopeIdentity),limit:20,...(afterId===undefined?{}:{afterId})});
   const fresh=askActionPageSchema.parse(await readPort(input));
   if(captured===epoch.current)setPage(fresh);
  }catch{if(captured===epoch.current){setPage(null);setNotice('Manual work is unavailable. Read current access again.');}}
  finally{if(captured===epoch.current)setBusy(false);}
 },[enabled,readPort,scopeIdentity,invalidate]);
 useLayoutEffect(()=>{void load();return ()=>{invalidate();};},[privacyKey,load,invalidate]);
 async function change(item:z.infer<typeof askActionPageSchema>['items'][number],action:z.infer<typeof askActionChangePayloadSchema>['action']){
  if(!enabled||busy||!ports.actionChange||item.supportState!=='current'||item.reviewRequired)return;
  const captured=invalidate();setPage(null);setBusy(true);setNotice(null);
  try{
   const receipt=askActionChangedSchema.parse(await ports.actionChange({actionId:item.actionId,expectedVersion:item.version,action}));
   if(captured!==epoch.current)return;
   if(receipt.actionId!==item.actionId||receipt.version<=item.version)throw new Error('changed_action');
   await load();
  }catch{if(captured===epoch.current){setPage(null);setNotice('Action change could not be confirmed. Read current work before trying again.');}}
  finally{if(captured===epoch.current)setBusy(false);}
 }
 return <section aria-label='Manual human work'>
  <h2>{scope.kind==='today'?'Your manual tasks':'Your manual work'}</h2>
  <p>Human tasks, annotations and private preference proposals are separate from promises and outreach.</p>
  <button disabled={!enabled||busy||!readPort} onClick={()=>{void load();}}>Read manual work</button>
  {notice!==null&&<p role='status'>{notice}</p>}
  {page?.items.length===0&&<p>No manual work on this page.</p>}
  {page?.items.map(item=><article key={item.actionId}>
   <p>{item.kind==='task'?'Manual task':item.kind==='note'?'Human annotation':'Private preference proposal'} · {item.status}</p>
   {item.supportState==='current'?<>
    {item.label!==null&&<p>{item.label}</p>}{item.text!==null&&<pre className='whitespace-pre-wrap break-words'>{item.text}</pre>}
    {item.due!==null&&<p>Due {item.due.kind==='date'?item.due.date:item.due.at} ({item.due.zone})</p>}
   </>:<p>Supporting evidence is {item.supportState}. Private content is unavailable.</p>}
   {item.reviewRequired&&<p>Evidence review is required before changing this work.</p>}
   {item.kind==='task'&&item.status==='open'&&item.supportState==='current'&&!item.reviewRequired&&<button disabled={!enabled||busy||!ports.actionChange} onClick={()=>{void change(item,'complete_task');}}>Complete manual task</button>}
   {item.kind==='task'&&item.status==='open'&&item.supportState==='current'&&!item.reviewRequired&&<button disabled={!enabled||busy||!ports.actionChange} onClick={()=>{void change(item,'cancel_task');}}>Cancel manual task</button>}
   {item.kind==='preference'&&item.status==='proposed'&&item.supportState==='current'&&!item.reviewRequired&&<button disabled={!enabled||busy||!ports.actionChange} onClick={()=>{void change(item,'dismiss_preference');}}>Dismiss preference proposal</button>}
   {item.completedAt!==null&&<p>Completed {item.completedAt}</p>}
  </article>)}
  {page?.nextAfterId!=null&&<button disabled={!enabled||busy} onClick={()=>{void load(page.nextAfterId??undefined);}}>Older manual work</button>}
 </section>;
}
