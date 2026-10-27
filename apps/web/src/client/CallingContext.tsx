import {useEffect,useState,type JSX} from 'react';
import {pluralFirmPageResponseSchema,manualProspectListSchema,manualProspectListInputSchema,todayActionOpenV4ResponseSchema,type PluralFirmPageResponse,type QualifiedResearchFirm,type AutomaticResearchFirm,type ManualProspect} from '@fss/contracts';
import type {CallingQueueEntry} from './CallingQueue.tsx';
import type {CallingSelection} from './workspaceNavigation.ts';
import type {BrowserClient} from './BrowserClient.ts';
import {manualProspectLabel} from './manualProspectPresentation.ts';
import {RetainedPhoneEvidence} from './RetainedPhoneEvidence.tsx';
import {BrowserPhoneDiscovery} from './BrowserPhoneDiscovery.tsx';
export type CallingContextEntry=CallingQueueEntry&Pick<CallingSelection,'prospectPage'>;
export interface CallingContextData{entry:CallingContextEntry;prospect?:ManualProspect;firm?:PluralFirmPageResponse;proof?:QualifiedResearchFirm|AutomaticResearchFirm;}
export function callingSafeWebsite(value:string|null):string|null{try{if(value){const url=new URL(value);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;}}catch{/* Observations are never executed. */}return null;}
export function callingWebsiteIdentitySupported(website:string|null,identityUrls:readonly string[]):boolean{const site=callingSafeWebsite(website);return site!==null&&identityUrls.some(value=>{const evidence=callingSafeWebsite(value);return evidence!==null&&new URL(evidence).hostname===new URL(site).hostname;});}
/** Current source-backed compact brief. The link is deliberate, never fetched or embedded. */
export function CallingContext({client,entry,onReady}:{client:BrowserClient;entry:CallingContextEntry;onReady:(data:CallingContextData|null)=>void}):JSX.Element{
 const [data,setData]=useState<CallingContextData|null>(null),[notice,setNotice]=useState('Loading current brief…');
 useEffect(()=>{let mounted=true,timer:ReturnType<typeof setTimeout>|undefined,loadedData:CallingContextData|null=null;const epoch=client.epoch,current=():boolean=>mounted&&client.isCurrent(epoch)&&client.current?.status==='signed_in';setData(null);onReady(null);setNotice('Loading current brief…');
  const project=():void=>{
   clearTimeout(timer);if(!current()||!loadedData)return;
   if(loadedData.proof){const remaining=Date.parse(loadedData.proof.validUntil)-Date.now();
    if(remaining<=0){const {proof:_expired,...recorded}=loadedData;loadedData=recorded;}
    else timer=setTimeout(project,Math.min(remaining,2_147_483_647));
   }
   setData(loadedData);onReady(loadedData);setNotice('');
  };
  const read=async():Promise<void>=>{try{let loaded:CallingContextData;
   if(entry.subject.kind==='candidate'){
    // Queue rows came from the current retained projection. Exact incoming links
    // use only a bounded page hint for a fresh read, never inferred Firms or a scan.
    let prospect=entry.prospect;
    if(!prospect){const input=manualProspectListInputSchema.parse(entry.prospectPage??{state:'all',offset:0});const page=await client.request('/sourcing/candidates/prospects/list',manualProspectListSchema,input,()=>{if(!current())throw Error('Brief changed');});const subject=entry.subject;prospect=page.prospects.find(p=>p.candidateId===subject.candidateId&&p.revision===subject.expectedCandidateRevision);}
    if(!prospect||prospect.candidateId!==entry.subject.candidateId||prospect.revision!==entry.subject.expectedCandidateRevision)throw Error('Exact current observation unavailable');
    loaded={entry,prospect};
   }else{
    const firm=await client.request('/crm/firm-page-v3',pluralFirmPageResponseSchema,{firmId:entry.subject.firmId,pageVersion:2,include:['stops','tasks','timeline','meeting_tasks']},()=>{if(!current())throw Error('Brief changed');});
    if(!current())return;if(firm.read.firm.id!==entry.subject.firmId||firm.read.visibility!=='assigned_or_admin'||firm.read.firm.status!=='active')throw Error('Firm access changed');
    loaded={entry,firm};
    if(entry.action){const answer=await client.request('/today/actions/open/v4',todayActionOpenV4ResponseSchema,{actionId:entry.action.actionId,target:entry.action.target},()=>{if(!current())throw Error('Brief changed');});const proof=answer.research??answer.automaticResearch;const id=proof&&('firmId' in proof?proof.firmId:proof.target.firmId);if(!proof||id!==entry.subject.firmId)throw Error('Prepared source changed');if(Date.parse(proof.validUntil)>Date.now())loaded={...loaded,proof};}
   }
   if(current()){loadedData=loaded;project();}
  }catch{if(current()){setData(null);onReady(null);setNotice('Current brief unavailable or source changed. Select a current list row or refresh. No call has been started.');}}};void read();
  const unsub=client.subscribe(()=>{if(!current()){loadedData=null;clearTimeout(timer);setData(null);onReady(null);setNotice('Current session required.');}else project();});return()=>{mounted=false;clearTimeout(timer);loadedData=null;unsub();};
 },[client,entry,onReady]);
 const p=data?.prospect,f=data?.firm?.read.firm,proof=data?.proof&&Date.parse(data.proof.validUntil)>Date.now()?data.proof:undefined,name=p?manualProspectLabel(p):f?.name??entry.label;
 const site=callingSafeWebsite(proof?.website??p?.website??f?.website??null);
 const identitySite=!!proof&&callingWebsiteIdentitySupported(site,proof.citations.filter(c=>c.kind==='firm_identity').map(c=>c.url));
 return <section className="calling-brief workspace-glass" aria-label="Current calling brief">{notice?<p role="status">{notice}</p>:null}<p className="workspace-eyebrow">{entry.subject.kind==='candidate'?'Retained observation · unverified':'Explicit canonical Firm'}</p><h2>{name}</h2><p>{p?[p.locality,p.region].filter(Boolean).join(', ')||'Location unknown':f?[f.locality,f.regionCode].filter(Boolean).join(', ')||'Location unknown':'Current location unavailable'}</p>{p?<RetainedPhoneEvidence evidence={p.phoneEvidence}/>:data?.firm?.read.visibility==='assigned_or_admin'?<><p>{data.firm.read.firm.phoneRoutes.length?data.firm.read.firm.phoneRoutes.map(r=>`${r.value} · ${r.eligibility}`).join(' / '):'Phone unknown · no current recorded route'}</p><p>{data.firm.read.firm.contacts.filter(c=>c.status==='active').map(c=>[c.fullName,c.title].filter(Boolean).join(' · ')).join(' / ')||'Person unknown'}</p></>:null}
 {p&&entry.subject.kind==='candidate'&&p.candidateId===entry.subject.candidateId&&p.revision===entry.subject.expectedCandidateRevision?<BrowserPhoneDiscovery client={client} candidateId={p.candidateId} revision={p.revision}/>:null}
 {site?<a className="calling-site" href={site} target="_blank" rel="noopener noreferrer">Open {identitySite?'source-backed':'observed'} website ↗</a>:<p>Website unknown or unsafe.</p>}
 {proof?<><p className="calling-objective">{proof.question}</p><details><summary>Research and source details</summary><p>Current research fit is not call permission. Maintenance need is not established.</p><ul>{proof.citations.map((c,i)=><li key={`${c.observationId}:${c.blockId}:${i}`}><strong>{c.kind.replaceAll('_',' ')}</strong><p>{c.quote}</p><small>{c.retrievedAt}</small>{callingSafeWebsite(c.url)?<a href={callingSafeWebsite(c.url)!} target="_blank" rel="noopener noreferrer">Open original source</a>:null}</li>)}</ul></details></>:p?<details><summary>Source details and unknowns</summary><p>Raw observation only. Not a unique Firm or permission to contact.</p><ul>{p.sources.map((s,i)=><li key={i}>{s.label} · {s.observedAt??'Date unknown'}{callingSafeWebsite(s.url)?<> <a href={callingSafeWebsite(s.url)!} target="_blank" rel="noopener noreferrer">Open source</a></>:null}</li>)}</ul>{p.sourceNotices.map((s,i)=><p key={i}>{s.label}</p>)}<p>{p.unknowns.join(' · ')}</p></details>:<p>Recorded company context only. Website identity support has not been established in this view.</p>}
 <p className="calling-boundary">{entry.subject.kind==='candidate'?'Manual report only. Retained observations do not authorize or reserve calls.':'Context is not calling permission. Browser calls require a separate explicit action and current server checks.'}</p></section>;
}
