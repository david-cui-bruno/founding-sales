import {useEffect,useReducer,useRef,useState} from 'react';
import type {SocialWeekly} from '@fss/contracts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {operations} from '../app/bridges.ts';
import {Button} from '../ui/button.tsx';
type Change={enabled:boolean;expectedRevision:number;commandId:string};
export interface WeeklyPorts{read():Promise<{view:SocialWeekly|null;reason:string|null}>;save(input:Change):Promise<{view:SocialWeekly|null;reason:string|null}>}
const defaults:WeeklyPorts={read:async()=>{const api=operations();if(!api)throw new Error('unavailable');return api.read('social.weekly',{});},save:async input=>{const api=operations();if(!api)throw new Error('unavailable');return api.command('social.saveWeekly',input);}};
type Memory={view:SocialWeekly|null;pending:Change|null;busy:boolean;error:string|null};
const fresh=():Memory=>({view:null,pending:null,busy:false,error:null}),memories=new WeakMap<object,Memory>();
export function WeeklyDrafts({ports=defaults}:{ports?:WeeklyPorts}){
 const epoch=useSessionEpoch(),[fallback]=useState(fresh),[,render]=useReducer(n=>n+1,0);let found=epoch?memories.get(epoch):fallback;if(!found){found=fresh();memories.set(epoch!,found);}const m=found,live=useRef(0),port=useRef(ports);port.current=ports;
 useEffect(()=>{const g=++live.current;m.busy=false;void port.current.read().then(a=>{if(live.current===g){m.view=a.view;render();}}).catch(()=>{});return()=>{live.current=g+1;};},[m]);
 const save=async()=>{if(m.busy||!m.view)return;const g=live.current,input=m.pending??{enabled:!m.view.enabled,expectedRevision:m.view.revision,commandId:crypto.randomUUID()};m.pending=input;m.busy=true;m.error=null;render();try{const a=await port.current.save(input);if(g!==live.current)return;if(a.view){m.view=a.view;m.pending=null;}else{if(!['offline','unreadable_answer'].includes(a.reason??'')){m.pending=null;const latest=await port.current.read();if(g!==live.current)return;m.view=latest.view;}m.error=m.pending?'The change is not confirmed. Retry the same request.':'The setting changed elsewhere or could not be saved. Check it and try again.';}}catch{if(g===live.current)m.error='The change is not confirmed. Retry the same request.';}finally{if(g===live.current){m.busy=false;render();}}};
 if(!m.view)return null;
 return <div className="rounded-lg border border-border p-4 text-sm"><div className="flex items-center justify-between gap-4"><div><p className="font-medium">Weekly draft ideas</p><p className="mt-1 text-muted-foreground">One batch of up to three ideas from new evidence every seven days, within your credit limits. You review and schedule each post.</p></div><Button variant="outline" disabled={m.busy} onClick={()=>void save()}>{m.busy?'Saving…':m.pending?'Retry setting change':m.view.enabled?'Turn off weekly drafts':'Enable weekly drafts'}</Button></div>
 {m.view.enabled&&m.view.nextAt&&<p className="mt-2 text-xs text-muted-foreground">Next check: {new Date(m.view.nextAt).toLocaleString()}</p>}
 {m.view.lastResult==='no_new_sources'&&<p className="mt-2 text-xs text-muted-foreground">Last check: no new usable sources.</p>}
 {m.view.lastResult==='sources_unavailable'&&<p className="mt-2 text-xs text-muted-foreground">Last check: the sources or product facts need review.</p>}
 {m.view.lastResult==='requests_pending'&&<p className="mt-2 text-xs text-muted-foreground">Last check: three batches were already pending.</p>}
 {m.error&&<p role="status" className="mt-2">{m.error}</p>}
 </div>;
}
