import {useCallback,useEffect,useMemo,useRef,useState,type JSX} from 'react';
import {prospectPhoneDiscoveryViewSchema,type ProspectPhoneDiscoveryView} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import type {PendingQualification} from './QualificationPending.ts';
import {dispatchQualification,reconcilePhoneDiscovery} from './QualificationDispatch.ts';
import {PhoneRefusalOriginalReview} from './PhoneRefusalOriginalReview.tsx';

type Action='request'|'read'|'receipt';
function evidenceExpiry(view:ProspectPhoneDiscoveryView):number{
 const evidence=view.phoneEvidence;
 const sources=evidence.state==='observed'||evidence.state==='conflicting'?evidence.sources:[];
 const diagnostics=evidence.state==='conflicting'?evidence.diagnostics:undefined;
 return Math.min(Date.parse(view.expiresAt),...(diagnostics?.expiresAt?[Date.parse(diagnostics.expiresAt)]:[]),
  ...(diagnostics?.entries??[]).flatMap(entry=>entry.authority.kind==='phone_discovery'?[Date.parse(entry.authority.expiresAt)]:[]),
  ...sources.flatMap(source=>'method' in source&&source.authority.kind==='phone_discovery'?[Date.parse(source.authority.expiresAt)]:[]));
}
/** Explicit phone-only acquisition. No mount/list IO, qualification, admission or retry. */
export function BrowserPhoneDiscovery({client,candidateId,revision}:{client:BrowserClient;candidateId:string;revision:number}):JSX.Element{
 const epoch=client.epoch;
 const binding=useMemo(()=>({client,candidateId,revision,epoch}),[client,candidateId,revision,epoch]);
 const latest=useRef(binding),mounted=useRef<typeof binding|null>(null),operation=useRef<symbol|null>(null);
 latest.current=binding;
 const [custody,setCustody]=useState<{binding:typeof binding;held:PendingQualification|null;failed:boolean}|null>(null);
 const [result,setResult]=useState<{binding:typeof binding;view:ProspectPhoneDiscoveryView}|null>(null);
 const [status,setStatus]=useState<{binding:typeof binding;text:string}|null>(null);
 const [working,setWorking]=useState<typeof binding|null>(null);
 const current=useCallback(():boolean=>latest.current===binding&&mounted.current===binding&&client.isCurrent(epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin',[binding,client,epoch]);
 useEffect(()=>{
  mounted.current=binding;operation.current=null;setWorking(null);setResult(null);setStatus(null);
  const update=():void=>{
   if(!current()){operation.current=null;setWorking(null);setResult(null);setStatus(null);setCustody(null);return;}
   try{const held=client.qualification.read();setCustody({binding,held,failed:false});if(held!==null&&held.receipt===undefined)setResult(null);}
   catch{setCustody({binding,held:null,failed:true});setResult(null);}
  };
  update();const unsubscribe=client.subscribe(update);
  return()=>{mounted.current=null;operation.current=null;unsubscribe();};
 },[binding,client,current]);
 const visible=result?.binding===binding&&current()&&evidenceExpiry(result.view)>Date.now()?result.view:null;
 // Expiry cleanup only. Never starts a read, capture, retry or polling loop.
 useEffect(()=>{
  if(result?.binding!==binding)return;
  const clear=():void=>{if(latest.current===binding&&mounted.current===binding){setResult(null);setStatus({binding,text:'Phone result expired. Read the current result explicitly. No capture was restarted.'});}};
  const remaining=evidenceExpiry(result.view)-Date.now();
  if(remaining<=0){clear();return;}
  const timer=setTimeout(clear,Math.min(remaining,2_147_483_647));return()=>clearTimeout(timer);
 },[binding,result]);
 const held=custody?.binding===binding?custody.held:null;
 const exact=held?.command.kind==='phone_discovery'&&held.command.payload.candidateId===candidateId&&held.command.payload.expectedRevision===revision;
 const unknown=held!==null&&held.receipt===undefined;
 const busy=working===binding;
 const unavailable=!current()||custody?.binding!==binding||custody.failed;
 const run=async(action:Action):Promise<void>=>{
  if(operation.current!==null||!current())return;
  const token=Symbol('phone-discovery');operation.current=token;setWorking(binding);setResult(null);setStatus(null);
  const active=():boolean=>current()&&operation.current===token;
  try{
   const previous=client.qualification.read();
   const own=previous?.command.kind==='phone_discovery'&&previous.command.payload.candidateId===candidateId&&previous.command.payload.expectedRevision===revision;
   if(action==='request'){
    if(previous!==null&&(previous.receipt===undefined||own))throw Error('Existing command must not be redispatched');
    const pending=client.qualification.prepare({kind:'phone_discovery',candidateId,expectedRevision:revision});
    const text=await dispatchQualification(client,pending,active);
    if(active())setStatus({binding,text});
   }else if(action==='receipt'){
    if(!own||!previous||previous.receipt!==undefined)throw Error('Exact unresolved phone command required');
    const state=await reconcilePhoneDiscovery(client,previous,active);
    if(active())setStatus({binding,text:state==='unknown'?'Phone discovery UNKNOWN. Keep this exact command held. Receipt-only recovery, never redispatch.':`Phone discovery receipt ${state}. Read current phone evidence separately.`});
   }else{
    if(previous!==null&&previous.receipt===undefined)throw Error('UNKNOWN requires receipt-only recovery');
    const readCurrent=():void=>{const pending=client.qualification.read();if(!active()||pending!==null&&pending.receipt===undefined)throw Error('Phone result changed or command unresolved');};
    const view=await client.request('/sourcing/candidates/phone-discovery/read',prospectPhoneDiscoveryViewSchema.nullable(),{candidateId,expectedRevision:revision},readCurrent);
    if(!active())return;
    readCurrent();
    if(view===null){setStatus({binding,text:'No phone discovery result is recorded for this exact observation. Phone remains unknown.'});return;}
    if(view.candidateId!==candidateId||view.candidateRevision!==revision||(own&&previous?.receipt?.kind==='phone_discovery'&&previous.receipt.result.runId!==view.runId))throw Error('Foreign phone result');
    if(evidenceExpiry(view)<=Date.now()){setStatus({binding,text:'Phone result expired. Phone remains unknown. No capture was restarted.'});return;}
    setResult({binding,view});
   }
  }catch{
   if(active()){setResult(null);setStatus({binding,text:'Phone discovery unavailable or response UNKNOWN. Retained observations remain reviewable. Keep unresolved commands held and recover only their receipt.'});}
  }finally{if(active()){operation.current=null;setWorking(null);}}
 };
 return <section aria-label="Business phone discovery">
  <p>Find company-published business phone evidence for this exact raw observation. Not qualification, verified identity or calling permission.</p>
  <button type="button" disabled={unavailable||busy||unknown||exact} onClick={()=>{void run('request');}}>Find business phone</button>
  <button type="button" disabled={unavailable||busy||unknown} onClick={()=>{void run('read');}}>Read phone result</button>
  {unknown?<p>{exact?'Phone discovery UNKNOWN. Receipt-only recovery, no redispatch.':'Another command is unresolved. Recover its exact receipt in command custody before requesting phone discovery.'}</p>:null}
  {unknown&&exact?<button type="button" disabled={unavailable||busy} onClick={()=>{void run('receipt');}}>Check phone discovery receipt</button>:null}
  {exact&&held?.receipt?.kind==='phone_discovery'?<p>Business phone discovery requested. Run {held.receipt.result.runId}. Read current evidence explicitly.</p>:null}
  {exact&&held?.receipt?.kind==='refused'?<p>Phone discovery request refused. Phone remains unverified.</p>:null}
  {custody?.binding===binding&&custody.failed?<p>Command custody unavailable. No request can be dispatched.</p>:null}
  {status?.binding===binding?<p role="status">{status.text}</p>:null}
  {visible?<div aria-label="Current phone discovery result"><p>Phone discovery {visible.state}{visible.reason?` · ${visible.reason.replaceAll('_',' ')}`:''}. No channel authority granted.</p><p>Requested {visible.requestedAt} · Checked {visible.checkedAt??'unknown'} · Expires {visible.expiresAt}</p>{visible.state==='complete'?<PhoneRefusalOriginalReview client={client} view={visible} expiresAt={evidenceExpiry(visible)}/>:<p>Phone evidence unavailable while discovery is {visible.state}. Phone remains unknown.</p>}</div>:null}
 </section>;
}
