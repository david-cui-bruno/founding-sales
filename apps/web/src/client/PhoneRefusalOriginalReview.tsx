import {useCallback,useEffect,useMemo,useRef,useState,type JSX} from 'react';
import {PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH,prospectPhoneRefusalOriginalSchema,type ProspectPhoneRefusalOriginal,type ProspectPhoneDiscoveryView} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {RetainedPhoneEvidence} from './RetainedPhoneEvidence.tsx';

/** Memory-only, one selected block from an explicitly read discovery result.
 * Subscription/timer callbacks erase only. They never read or retry originals. */
export function PhoneRefusalOriginalReview({client,view,expiresAt}:{client:BrowserClient;view:ProspectPhoneDiscoveryView;expiresAt:number}):JSX.Element{
 const epoch=client.epoch,binding=useMemo(()=>({client,view,epoch}),[client,view,epoch]);
 const latest=useRef(binding),mounted=useRef<typeof binding|null>(null),operation=useRef<symbol|null>(null);
 latest.current=binding;
 const [selected,setSelected]=useState<{binding:typeof binding;value:ProspectPhoneRefusalOriginal}|null>(null);
 const [status,setStatus]=useState<{binding:typeof binding;text:string}|null>(null);
 const current=useCallback(():boolean=>latest.current===binding&&mounted.current===binding&&client.isCurrent(epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin'&&expiresAt>Date.now(),[binding,client,epoch,expiresAt]);
 const allowed=useCallback(():boolean=>{try{const held=client.qualification.read();return current()&&(held===null||held.receipt!==undefined);}catch{return false;}},[client,current]);
 useEffect(()=>{
  mounted.current=binding;operation.current=null;setSelected(null);setStatus(null);
  const erase=():void=>{operation.current=null;setSelected(null);setStatus(null);};
  const unsubscribe=client.subscribe(()=>{if(!allowed())erase();});
  const timer=setTimeout(erase,Math.max(0,Math.min(expiresAt-Date.now(),2_147_483_647)));
  return()=>{mounted.current=null;operation.current=null;unsubscribe();clearTimeout(timer);};
 },[binding,expiresAt,client,allowed]);
 const select=async(location:ProspectPhoneRefusalOriginal['location']):Promise<void>=>{
  operation.current=null;setSelected(null);setStatus(null);
  if(!allowed()||location.runId!==view.runId||location.authority.kind!=='phone_discovery'||location.authority.runId!==view.runId||location.lineage.kind!=='provider_original')return;
  const token=Symbol('selected-refusal');operation.current=token;
  const active=():boolean=>operation.current===token&&allowed()&&location.authority.kind==='phone_discovery'&&Date.parse(location.authority.expiresAt)>Date.now();
  const guard=():void=>{if(!active())throw Error('Selected refusal changed');};
  try{
   const value=await client.request(PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH,prospectPhoneRefusalOriginalSchema,{
    candidateId:view.candidateId,expectedRevision:view.candidateRevision,runId:view.runId,observationId:location.observationId,blockId:location.blockId,
    labelStart:location.labelStart,labelEnd:location.labelEnd,reason:location.reason,
   },guard);
   guard();
   if(value.candidateId!==view.candidateId||value.candidateRevision!==view.candidateRevision||JSON.stringify(value.location)!==JSON.stringify(location))throw Error('Foreign original');
   setSelected({binding,value});
  }catch{if(active()){setSelected(null);setStatus({binding,text:'Retained refusal original unavailable or changed. No capture or retry was started.'});}}
  finally{if(operation.current===token)operation.current=null;}
 };
 const visible=selected?.binding===binding&&allowed()?selected.value:null;
 return <>
  <RetainedPhoneEvidence evidence={view.phoneEvidence} review={{runId:view.runId,select:location=>{void select(location);}}}/>
  {status?.binding===binding?<p role="status">{status.text}</p>:null}
  {visible?<section aria-label="Selected retained refusal original">
   <p>Whole retained original for manual refusal review only. No channel authority granted. Not a selected endpoint, verified identity or call permission.</p>
   <p>Run {visible.location.runId} · Observation {visible.location.observationId} · Block {visible.location.blockId} · Label UTF-16 [{visible.location.labelStart}, {visible.location.labelEnd}) · {visible.location.reason}</p>
   <p>Retained source {visible.location.url} · Retrieved {visible.location.retrievedAt} · Parser {visible.location.parser}</p>
   <p>Captured content hash {visible.location.contentHash} · Retained blocks hash {visible.location.relevantTextHash}. Provider original, not a fresh page check.</p>
   <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{visible.text}</pre>
   <button type="button" onClick={()=>{operation.current=null;setSelected(null);setStatus(null);}}>Close retained original</button>
  </section>:null}
 </>;
}
