import {useEffect,useRef,useState,type JSX} from 'react';
import {socialDraftWorkspaceSchema,socialDraftViewSchema,type SocialDraftWorkspace,type SocialDraftView} from '@fss/contracts';
import {z} from 'zod';
import {BrowserPrivateComposer,type PrivateAdoption} from './BrowserPrivateComposer.tsx';
import {BrowserVoicePreferences} from './BrowserVoicePreferences.tsx';
import {BrowserSocialFacts} from './BrowserSocialFacts.tsx';
import {BrowserSocialGeneration} from './BrowserSocialGeneration.tsx';
import type {BrowserClient} from './BrowserClient.ts';

/** Retained suggestion review plus explicitly saved private composition. */
export function BrowserSocialReview({client}:{client:BrowserClient}):JSX.Element{
 const binding=useRef({client,key:0});
 if(binding.current.client!==client)binding.current={client,key:binding.current.key+1};
 return <SocialReviewSession key={binding.current.key} client={client}/>;
}
function SocialReviewSession({client}:{client:BrowserClient}):JSX.Element|null{
 const [signedIn,setSignedIn]=useState(client.current?.status==='signed_in');
 const [epoch,setEpoch]=useState(client.epoch),[workspace,setWorkspace]=useState<SocialDraftWorkspace|null>(null);
 const [adoption,setAdoption]=useState<PrivateAdoption|null>(null);
 const [factsOpen,setFactsOpen]=useState(false),[factsRevision,setFactsRevision]=useState(0);
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState('Read retained suggestions or write privately below.');
 const scope=useRef(client),owner=useRef(0),lock=useRef(false);scope.current=client;
 useEffect(()=>{
  const clear=():void=>{owner.current++;lock.current=false;setBusy(false);setWorkspace(null);setAdoption(null);setFactsOpen(false);setEpoch(client.epoch);setNotice('Private social content cleared. Read retained suggestions or write privately below.');};
  clear();let observed=client.epoch;
  const requestOwner=owner;
  const unsubscribe=client.subscribe(()=>{setSignedIn(client.current?.status==='signed_in');if(observed!==client.epoch||client.current?.status!=='signed_in'){observed=client.epoch;clear();}});
  return ()=>{requestOwner.current++;lock.current=false;unsubscribe();};
 },[client]);
 useEffect(()=>{
  const deadlines=workspace?.requests.filter(request=>request.state==='ready').map(request=>Date.parse(request.deadlineAt))??[];
  if(!deadlines.length)return;
  const timer=setTimeout(()=>setWorkspace(value=>value?expireWorkspace(value):null),Math.max(0,Math.min(...deadlines)-Date.now()));
  return ()=>clearTimeout(timer);
 },[workspace]);
 const read=async(selected?:SocialDraftView,conceptIndex?:number,variantIndex?:number):Promise<void>=>{
  if(lock.current||client.current?.status!=='signed_in')return;
  lock.current=true;setBusy(true);const generation=client.epoch,token=++owner.current;
  const current=():boolean=>scope.current===client&&owner.current===token&&client.isCurrent(generation);
  // Any explicit evidence refresh discards previously adopted prose and provenance.
  setAdoption(null);setWorkspace(null);
  setNotice('Reading current retained evidence…');
  try{
   if(selected===undefined){
    const result=await client.request('/social/drafts',socialDraftWorkspaceSchema,{},()=>{if(!current())throw Error('Scope changed');});
    if(!current())return;setWorkspace(expireWorkspace(result));setNotice(result.requests.length?'Retained suggestions require a current re-read before use.':'No retained suggestions. Manual private composition is available without an account or provider.');
   }else{
    const result=await client.request('/social/drafts/read',z.strictObject({request:socialDraftViewSchema}),{requestId:selected.id},()=>{if(!current())throw Error('Scope changed');});
    if(!current())return;
    const fresh=result.request;
    // Compare the exact retained selection, not merely the request ID or array position.
    if(fresh.id!==selected.id||fresh.state!=='ready'||new Date(fresh.deadlineAt).getTime()<=Date.now()||JSON.stringify(fresh)!==JSON.stringify(selected)){
     setAdoption(null);setNotice('Suggestion changed, expired or unavailable. Nothing adopted. Read retained suggestions again.');return;
    }
    const variant=fresh.concepts?.[conceptIndex??-1]?.variants[variantIndex??-1];
    if(!variant)throw Error('Variant unavailable');
    setAdoption({request:fresh,conceptIndex:conceptIndex!,variantIndex:variantIndex!});setNotice('Current ready suggestion adopted privately. Provenance is not proof of semantic support. Human review required.');
   }
  }catch{if(current()){setAdoption(null);setNotice('Social evidence unavailable or access refused. No action was retried.');}}
  finally{if(current()){lock.current=false;setBusy(false);}}
 };
 if(!signedIn||client.current?.status!=='signed_in'||epoch!==client.epoch||scope.current!==client)return null;
 return <section aria-label="Private social review" className="social-review">
  <BrowserPrivateComposer client={client} adoption={adoption} reviewBusy={busy} reviewRevision={owner.current} onDiscard={()=>{owner.current++;lock.current=false;setBusy(false);setAdoption(null);setWorkspace(null);}}/>
  <button type="button" aria-expanded={factsOpen} onClick={()=>setFactsOpen(value=>!value)}>Author shared facts</button>
  {factsOpen?<BrowserSocialFacts client={client} onFactsChanged={()=>{owner.current++;lock.current=false;setBusy(false);setAdoption(null);setWorkspace(null);setFactsRevision(value=>value+1);}}/>:null}
  <BrowserSocialGeneration key={factsRevision} client={client} claimProjection={()=>{
   // One explicit interaction owner spans guided projection and retained review.
   // Superseding a projection never clears or replays its opaque command custody.
   const token=++owner.current,generation=client.epoch;lock.current=false;setBusy(false);setAdoption(null);setWorkspace(null);
   return ()=>owner.current===token&&scope.current===client&&client.isCurrent(generation);
  }} onCurrentRequest={request=>{setAdoption(null);setWorkspace(request?expireWorkspace({sources:[],facts:[],requests:[request]}):null);}}/>
  <div className="social-secondary-toolbar">
  <button type="button" disabled={busy} onClick={()=>{void read();}}>Read retained social suggestions</button>
  </div>
  <p role="status" className="social-notice">{notice}</p>
  <details className="social-details" open={workspace!==null||busy}><summary>Retained suggestions & sources</summary>
  <p>Guided requests require explicit current guide and approved fact selection above. No automatic voice learning, source acquisition or platform action is available. Retained source metadata is dated provenance, not current coverage or semantic support.</p>
  {workspace!==null?<div className="space-y-3">
   <details><summary>Retained source metadata ({workspace.sources.length}, at most 60)</summary><ul>{workspace.sources.map(source=><li key={`${source.kind}:${source.id}`}>{source.label} · {source.kind} {source.id} revision {source.revision} · Observed {source.observedAt}</li>)}</ul></details>
   <details><summary>Current approved factual inputs ({workspace.facts.length}, at most 20)</summary><ul>{workspace.facts.map(fact=><li key={fact.id}>{fact.text}<small className="block">Fact {fact.id} version {fact.version}{fact.socialInput?` · ${fact.socialInput.topic} · ${fact.socialInput.status}${fact.socialInput.sourceRef?` · Public original ${fact.socialInput.sourceRef.id} revision ${fact.socialInput.sourceRef.revision} · ${fact.socialInput.sourceRef.url} · Checked ${fact.socialInput.sourceRef.checkedAt}`:''}`:''}</small></li>)}</ul></details>
   <h3>Retained requests (at most 20)</h3>
   {workspace.requests.length===0?<p>No retained suggestion requests. No inference has been run by this screen.</p>:null}
   {workspace.requests.map(request=><article key={request.id} aria-label={`Social request ${request.id}`} className="social-retained-request">
    <h4>{request.state} · {request.mode??'legacy themes'}</h4><p>Request {request.id} · Created {request.createdAt} · Deadline {request.deadlineAt}</p>
    {request.reason?<p>Reason: {request.reason}</p>:null}
    <Provenance request={request}/>
    {request.state==='ready'?request.concepts?.map((concept,ci)=><div key={ci}><h5>{concept.theme}</h5><p>Variant fact references: {concept.factRefs.map(ref=>`${ref.id} v${ref.version}`).join(', ')||'None'}</p>{concept.variants.map((variant,vi)=><div key={vi}><p className="whitespace-pre-wrap">{variant.text}</p><button type="button" disabled={busy||new Date(request.deadlineAt).getTime()<=Date.now()} onClick={()=>{void read(request,ci,vi);}}>Re-read and use {variant.platform} suggestion {ci+1}.{vi+1}</button></div>)}</div>):<p>Not available for adoption. No supported text is presented.</p>}
   </article>)}
  </div>:null}
  </details>
  <details className="social-details"><summary>Private voice guide</summary><BrowserVoicePreferences client={client}/></details>
 </section>;
}
function expireWorkspace(workspace:SocialDraftWorkspace):SocialDraftWorkspace{
 return {...workspace,requests:workspace.requests.map(request=>request.state==='ready'&&Date.parse(request.deadlineAt)<=Date.now()?{...request,state:'expired',concepts:null}:request)};
}
function Provenance({request}:{request:SocialDraftView}):JSX.Element{
 return <div><p>Source provenance, not semantic support: {request.sourceRefs.map(ref=>`${ref.kind} ${ref.id} revision ${ref.revision}`).join(', ')||'No source references'}</p><p>Request fact references: {request.factBlocks.map(ref=>`${ref.id} version ${ref.version}`).join(', ')||'None'}</p></div>;
}
