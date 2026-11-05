import {useEffect,useState,type JSX} from 'react';
import {socialStandingOptionsSchema,socialPublisherConnectionInputSchema,socialPublisherConnectionResultSchema} from '@fss/contracts';
import {BrowserSocialPublisherConnection} from './BrowserSocialPublisherConnection.tsx';
import {BrowserSocialPublishingReadiness} from './BrowserSocialPublishingReadiness.tsx';
import type {BrowserClient} from './BrowserClient.ts';

export function BrowserSocialAccount({client,onReviewPlan}:{client:BrowserClient;onReviewPlan:()=>void}):JSX.Element{
 const [accountId,setAccountId]=useState<string|null|undefined>(),[error,setError]=useState(false),[refresh,setRefresh]=useState(0),[connected,setConnected]=useState(false);
 const [savedProfile,setSavedProfile]=useState<{client:BrowserClient;epoch:number;displayName:string|null;externalId:string}|null>(null);
 useEffect(()=>{
  let active=true;const epoch=client.epoch;
  const current=()=>{if(!active||!client.isCurrent(epoch))throw Error('Account view changed');};
  void client.request('/social/standing-plan/options',socialStandingOptionsSchema,{},current).then(options=>{
   current();setAccountId(options.intendedAccountId);setSavedProfile(options.binding?{client,epoch,displayName:options.accountDisplayName,externalId:options.binding.externalId}:null);setError(false);
  }).catch(()=>{if(active){setAccountId(undefined);setError(true);}});
  return()=>{active=false;};
 },[client,refresh]);
 return <div className="social-account-page">
  <div className="social-page-intro"><h2>Your LinkedIn account</h2><p>Connect first. Choose when and what to publish afterward.</p></div>
  <div className="social-surface social-connection-card">
   {savedProfile&&savedProfile.client===client&&client.isCurrent(savedProfile.epoch)&&client.current?.status==='signed_in'?<section aria-label="Saved Buffer connection"><h3>{savedProfile.displayName??'Connected personal profile'}</h3><p>LinkedIn profile ID: <span>{savedProfile.externalId}</span></p><p>This is your saved publishing profile. You do not need to enter a key again to review it. Reconnecting or changing profiles never activates publishing.</p></section>:null}
   {accountId===undefined?<div role="status"><p>{error?'We couldn’t read your saved account. No Buffer connection was started.':'Reading your saved account…'}</p>{error?<button onClick={()=>{setError(false);setRefresh(value=>value+1);}}>Try loading again</button>:null}</div>:<BrowserSocialPublisherConnection client={client} {...(accountId===null?{}:{reconnectAccountId:accountId})} transport={(input,current)=>client.request('/social/publisher/connection',socialPublisherConnectionResultSchema,socialPublisherConnectionInputSchema.parse(input),current)} onConnected={()=>{setConnected(true);setRefresh(value=>value+1);}} onDisconnected={()=>{setConnected(false);setRefresh(value=>value+1);}}/>}
   {connected?<div className="social-connection-next"><p>Next: review your material and three weekly time slots.</p><button className="workspace-primary" onClick={onReviewPlan}>Review publishing plan</button></div>:null}
  </div>
  <details className="social-details social-diagnostics"><summary>Connection diagnostics</summary><BrowserSocialPublishingReadiness client={client}/></details>
 </div>;
}
