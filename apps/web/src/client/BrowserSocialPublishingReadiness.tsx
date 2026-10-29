import {useLayoutEffect,useRef,useState,type JSX} from 'react';
import {socialPublishingReadinessSchema,type SocialPublishingReadiness,type SocialPublishingReadinessHold} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';

const labels:Record<SocialPublishingReadinessHold,string>={
 adapter_unavailable:'Publishing runner unavailable',current_account_unverified:'Current account verification unavailable',
 current_publication_policy_unavailable:'Current publishing policy unavailable',unsupported_route:'This publishing route is unsupported',
};
/** Explicit metadata read only. Stored connection markers never imply readiness. */
export function BrowserSocialPublishingReadiness({client}:{client:BrowserClient}):JSX.Element|null{
 const [view,setView]=useState<SocialPublishingReadiness|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const mounted=useRef(false),operation=useRef<symbol|null>(null),binding=useRef(client);binding.current=client;
 useLayoutEffect(()=>{
  mounted.current=true;let epoch=client.epoch;
  const clear=()=>{operation.current=null;setView(null);setBusy(false);setError('');};clear();
  const off=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;clear();}});
  return ()=>{mounted.current=false;operation.current=null;off();};
 },[client]);
 const read=async()=>{
  if(operation.current||client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  const token=Symbol('social-publishing-readiness'),epoch=client.epoch;operation.current=token;setBusy(true);setView(null);setError('');
  const current=()=>mounted.current&&binding.current===client&&operation.current===token&&client.isCurrent(epoch)
   &&client.current?.status==='signed_in'&&client.current.role==='admin';
  try{
   const result=await client.request('/social/publishing/readiness',socialPublishingReadinessSchema,{},()=>{if(!current())throw Error('Read superseded');});
   if(current())setView(result);
  }catch{if(current())setError('Publishing readiness is unavailable. Read again explicitly; this does not grant publishing permission.');}
  finally{if(current()){operation.current=null;setBusy(false);}}
 };
 if(client.current?.status!=='signed_in'||client.current.role!=='admin')return null;
 return <section aria-label="Publishing readiness" className="social-details">
  <h3>Publishing readiness</h3>
  <p>Publishing is not activated. Saved account records do not prove current account verification or a working publishing runner.</p>
  <p>A LinkedIn personal-profile text post is a potential target only. Facebook profiles and groups are unsupported here.</p>
  <button type="button" disabled={busy} onClick={()=>{void read();}}>Read publishing readiness</button>
  {busy?<p role="status">Reading saved account metadata.</p>:null}{error?<p role="alert">{error}</p>:null}
  {view?<div><p>Observed {view.observedAt} · Publishing remains unavailable.</p>
   <ul>{view.holds.map(reason=><li key={reason}>{labels[reason]}</li>)}</ul>
   {view.accounts.length?<ul>{view.accounts.map(account=><li key={account.accountId}>
    <strong>{account.displayName}</strong> · {account.platform} {account.accountKind} · Revision {account.revision}
    <p>Saved status: {account.historicalState} (historical record). Current account verification is unavailable.</p>
    <ul>{account.holds.map(reason=><li key={reason}>{labels[reason]}</li>)}</ul>
   </li>)}</ul>:<p>No saved accounts are available in this read.</p>}
  </div>:null}
 </section>;
}
