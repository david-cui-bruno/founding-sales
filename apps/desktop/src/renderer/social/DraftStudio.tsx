import {WeeklyDrafts} from './WeeklyDrafts.tsx';
import {useCallback,useEffect,useReducer,useRef,useState} from 'react';
import type {SocialDraftRequest,SocialDraftWorkspace} from '@fss/contracts';
import {operations} from '../app/bridges.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {Button} from '../ui/button.tsx';
type Request=SocialDraftRequest&{commandId:string};
type Variant={platform:'linkedin'|'facebook'|'x';text:string};
export interface DraftStudioPorts{read():Promise<{view:SocialDraftWorkspace|null;reason:string|null}>;request(input:Request):Promise<{requestId:string|null;reason:string|null}>}
const defaults:DraftStudioPorts={read:async()=>{const api=operations();if(!api)throw new Error('unavailable');return api.read('social.drafts',{});},request:async input=>{const api=operations();if(!api)throw new Error('unavailable');return api.command('social.requestDrafts',input);}};
type Memory={view:SocialDraftWorkspace|null;sources:Set<string>;facts:Set<string>;pending:Request|null;busy:boolean;error:string|null};
const fresh=():Memory=>({view:null,sources:new Set(),facts:new Set(),pending:null,busy:false,error:null});const memories=new WeakMap<object,Memory>();
const key=(s:SocialDraftRequest['sourceRefs'][number])=>`${s.kind}:${s.id}:${s.revision}`;
const names={linkedin:'LinkedIn',facebook:'Facebook',x:'X'};
const themes={after_hours:'After-hours maintenance',small_team:'Small teams',manual_entry:'Less manual entry',vendor_follow_up:'Vendor follow-up',tenant_phone:'A dedicated maintenance line',maintenance_coordination:'Maintenance coordination'};
function reason(r:string|null){return ({no_supported_theme_or_input_too_large:'These sources do not contain a supported maintenance topic, or are too long. Try another source.',source_changed_or_unavailable:'A source changed or is no longer available. Refresh and select it again.',draft_requests_pending:'Three batches are already in progress. Wait for one to finish.',block_changed:'A product fact changed. Refresh and select the latest version.',block_unapproved:'A selected fact is no longer approved.',owner_unavailable:'Your workspace access changed.'}[r??'']??'Could not generate these drafts. Refresh and try again.');}
export function SocialDraftStudio({ports=defaults,onUse,disabled=false}:{ports?:DraftStudioPorts;onUse:(variant:Variant)=>void;disabled?:boolean}){
 const epoch=useSessionEpoch(),[fallback]=useState(fresh),[,render]=useReducer(n=>n+1,0);let found=epoch?memories.get(epoch):fallback;if(!found){found=fresh();memories.set(epoch!,found);}const m=found,live=useRef(0),port=useRef(ports);port.current=ports;
 const refresh=useCallback(async(g=live.current)=>{try{const answer=await port.current.read();if(g!==live.current)return;if(answer.view){m.view=answer.view;m.error=null;}else m.error='Could not refresh draft suggestions.';}catch{if(g===live.current)m.error='Could not refresh draft suggestions.';}if(g===live.current)render();},[m]);
 useEffect(()=>{const g=++live.current;m.busy=false;void refresh(g);const timer=setInterval(()=>{if(m.view?.requests.some(r=>r.state==='queued'||r.state==='calling'))void refresh(g);},15000);return()=>{live.current=g+1;clearInterval(timer);};},[m,refresh]);
 const submit=async()=>{if(m.busy)return;const selection=m.pending??{commandId:crypto.randomUUID(),sourceRefs:(m.view?.sources??[]).filter(s=>m.sources.has(key(s))).map(({kind,id,revision})=>({kind,id,revision})),factBlocks:(m.view?.facts??[]).filter(f=>m.facts.has(`${f.id}:${f.version}`)).map(({id,version})=>({id,version}))};if(!selection.sourceRefs.length)return;const g=live.current;m.pending=selection;m.busy=true;m.error=null;render();try{const answer=await port.current.request(selection);if(g!==live.current)return;if(answer.requestId){m.pending=null;m.sources.clear();m.facts.clear();await refresh(g);}else{if(!['offline','unreadable_answer'].includes(answer.reason??''))m.pending=null;m.error=m.pending?'No definite answer. Retry the same request.':reason(answer.reason);}}catch{if(g===live.current)m.error='No definite answer. Retry the same request.';}finally{if(g===live.current){m.busy=false;render();}}};
 const toggle=(set:Set<string>,id:string)=>{if(set.has(id))set.delete(id);else set.add(id);render();};
 return <div className="space-y-5" aria-label="Draft ideas">
  <WeeklyDrafts/>
  <details className="rounded-xl border border-border bg-card p-5" open><summary className="cursor-pointer text-sm font-medium">Draft from your work</summary><p className="my-3 text-sm text-muted-foreground">Choose up to ten sources. Only general maintenance themes go into generation. Nothing is scheduled.</p>
   <div className="max-h-60 space-y-2 overflow-auto">{m.view?.sources.map(s=><label key={key(s)} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={m.sources.has(key(s))} disabled={m.busy||m.pending!==null||(!m.sources.has(key(s))&&m.sources.size>=10)} onChange={()=>toggle(m.sources,key(s))}/><span>{s.label} · {s.kind==='public'?'Research':s.kind==='meeting'?'Meeting':'Call'} · {new Date(s.observedAt).toLocaleDateString()}</span></label>)}</div>
   {m.view?.sources.length===0&&<p className="text-sm text-muted-foreground">No sources yet. Completed call transcripts, meeting transcripts, and public research appear here.</p>}
   <p className="mt-2 text-xs text-muted-foreground">Showing the latest 20 sources of each kind.</p>
   {!!m.view?.facts.length&&<fieldset className="my-4 space-y-2"><legend className="mb-2 text-sm font-medium">Approved product facts (optional)</legend>{m.view.facts.map(f=><label key={`${f.id}:${f.version}`} className="flex gap-2 text-sm"><input type="checkbox" checked={m.facts.has(`${f.id}:${f.version}`)} disabled={m.busy||m.pending!==null} onChange={()=>toggle(m.facts,`${f.id}:${f.version}`)}/>{f.text}</label>)}</fieldset>}
   <div className="mt-4 flex gap-2"><Button disabled={m.busy||(!m.pending&&!m.sources.size)} onClick={()=>void submit()}>{m.busy?'Requesting…':m.pending?'Retry request':'Generate drafts'}</Button><Button variant="ghost" disabled={m.busy} onClick={()=>void refresh()}>Refresh suggestions</Button></div>
   {m.error&&<p role="status" className="mt-3 text-sm">{m.error}</p>}
  </details>
  {m.view?.requests.map(r=><section key={r.id} className="space-y-3" aria-label="Generated batch">
   {r.state!=='ready'&&<p className="text-sm text-muted-foreground">{r.state==='queued'||r.state==='calling'?'Drafts are being prepared.':r.state==='expired'?'This request expired before it finished. Choose sources to try again.':'This batch needs another look. Choose different sources or approved facts.'}</p>}
   {r.concepts?.map((c,i)=><article key={i} className="rounded-xl border border-border bg-card p-5"><h3 className="mb-3 text-sm font-medium">{themes[c.theme]}</h3><div className="grid gap-4 lg:grid-cols-3">{c.variants.map(v=><div key={v.platform} className="space-y-3"><p className="text-xs font-medium text-muted-foreground">{names[v.platform]}</p><p className="whitespace-pre-wrap text-sm leading-relaxed">{v.text}</p><Button variant="outline" disabled={disabled} onClick={()=>onUse(v)}>Use {names[v.platform]} draft</Button></div>)}</div><details className="mt-4 text-xs text-muted-foreground"><summary>Private source references</summary><ul>{r.sourceRefs.map(s=><li key={key(s)}>{m.view?.sources.find(v=>key(v)===key(s))?.label??`${s.kind} source no longer in recent list`} · version {s.revision}</li>)}</ul></details></article>)}
  </section>)}
 </div>;
}
