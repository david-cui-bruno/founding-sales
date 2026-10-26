import {useCallback,useEffect,useMemo,useRef,useState,type JSX} from 'react';
import {z} from 'zod';
import {socialDraftWorkspaceSchema,socialDraftViewSchema,socialVoiceReadSchema,socialGuidedRequestSavedSchema,socialGuidedRequestReceiptSchema,type SocialDraftWorkspace,type SocialDraftView,type SocialVoiceGuide} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {SocialGenerationCustody,SOCIAL_GENERATION_PENDING_PREFIX,type SocialGenerationPending} from './SocialGenerationPending.ts';
import {revalidateSocialSelection} from './SocialGenerationDispatch.ts';
const answerSchema=z.union([z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:socialGuidedRequestSavedSchema}),z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string().min(1).max(100)})]);
/** Explicit selection through existing request/read owners. Nothing is adopted,
 * saved, retried, polled or published as a side effect of request acceptance. */
export function BrowserSocialGeneration({client,onCurrentRequest}:{client:BrowserClient;onCurrentRequest:(request:SocialDraftView|null)=>void}):JSX.Element|null{
 const custody=useMemo(()=>new SocialGenerationCustody(client),[client]);
 const [workspace,setWorkspace]=useState<SocialDraftWorkspace|null>(null),[guide,setGuide]=useState<SocialVoiceGuide|null>(null);
 const [guideSelected,setGuideSelected]=useState(false),[facts,setFacts]=useState<string[]>([]),[pending,setPending]=useState<SocialGenerationPending|null>(null);
 const [busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false),[requestId,setRequestId]=useState<string|null>(null);
 const [notice,setNotice]=useState('Read current approved facts and your saved voice guide, then select both explicitly.');
 const mounted=useRef(false),token=useRef(0),guard=useRef(false),binding=useRef(client.epoch),callback=useRef(onCurrentRequest);callback.current=onCurrentRequest;
 const clearSelection=():void=>{setWorkspace(null);setGuide(null);setGuideSelected(false);setFacts([]);};
 const held=useCallback(()=>{try{setPending(custody.read());}catch{setBlocked(true);setNotice('Social request custody unavailable or changed. Replacement requests are blocked.');}},[custody]);
 useEffect(()=>{
  mounted.current=true;held();
  const clear=():void=>{if(binding.current!==client.epoch||client.current?.status!=='signed_in'){binding.current=client.epoch;token.current++;guard.current=false;setBusy(false);clearSelection();setPending(null);setRequestId(null);callback.current(null);}};
  const unsubscribe=client.subscribe(clear);
  const changed=(event:StorageEvent):void=>{if(!event.key?.startsWith(SOCIAL_GENERATION_PENDING_PREFIX)||event.key!==custody.binding()?.key)return;token.current++;guard.current=false;setBusy(false);clearSelection();setRequestId(null);callback.current(null);held();};
  window.addEventListener('storage',changed);
  const operationToken=token;
  return ()=>{mounted.current=false;operationToken.current++;guard.current=false;unsubscribe();window.removeEventListener('storage',changed);};
 },[client,custody,held]);
 const operation=async(work:(current:()=>boolean)=>Promise<void>):Promise<void>=>{
  if(guard.current||blocked||client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  guard.current=true;setBusy(true);const id=++token.current,epoch=client.epoch;
  const current=()=>mounted.current&&token.current===id&&client.isCurrent(epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin';
  try{await work(current);}catch{if(current()){held();clearSelection();callback.current(null);setNotice('Selection changed, access refused or request outcome unknown. Read current inputs again, or reconcile pending custody. No automatic retry or replacement.');}}
  finally{if(current()){guard.current=false;setBusy(false);}}
 };
 const inputs=async(current:()=>boolean)=>{
  const check=()=>{if(!current())throw Error('Scope changed');};
  const workspace=await client.request('/social/drafts',socialDraftWorkspaceSchema,{},check);
  const voice=await client.request('/social/voice-preferences/read',socialVoiceReadSchema,{},check);check();
  return {workspace,guide:voice.guide};
 };
 const read=()=>operation(async current=>{if(custody.read())throw Error('Reconcile first');clearSelection();const next=await inputs(current);if(!current())return;setWorkspace(next.workspace);setGuide(next.guide);setNotice('Current retained inputs read. Explicitly select the exact saved guide revision and at least one approved social fact.');});
 const currentRequest=async(id:string,current:()=>boolean):Promise<void>=>{
  callback.current(null);const result=await client.request('/social/drafts/read',z.strictObject({request:socialDraftViewSchema}),{requestId:id},()=>{if(!current())throw Error('Scope changed');});
  if(!current())return;if(result.request.id!==id)throw Error('Request changed');
  callback.current(result.request);setNotice(result.request.state==='ready'&&Date.parse(result.request.deadlineAt)>Date.now()?'Current ready suggestion read. Choose an exact variant below to re-read and adopt privately. Nothing saved automatically.':`Current request ${result.request.state}. No ready text adopted. Use Read current requested suggestion explicitly when ready.`);
 };
 const outcome=async(answer:z.infer<typeof answerSchema>,attempt:SocialGenerationPending,current:()=>boolean):Promise<void>=>{
  if(!current())return;custody.complete(attempt);setPending(null);clearSelection();
  if(answer.status==='refused'){setNotice(`Social request refused: ${answer.reason}. Nothing retried or adopted.`);return;}
  setRequestId(answer.result.requestId);await currentRequest(answer.result.requestId,current);
 };
 const dispatch=()=>operation(async current=>custody.exclusive(async()=>{
  if(!current()||custody.read()||!workspace||guide?.state!=='available'||!guideSelected)throw Error('Select inputs first');
  const selection={guide,facts:workspace.facts.filter(fact=>facts.includes(fact.id))};
  callback.current(null);setRequestId(null);
  const next=await inputs(current),input=revalidateSocialSelection(selection,next.workspace,next.guide);
  const prepared=await custody.prepare(input,current);if(!current())return;setPending(prepared.held);
  const answer=await client.request('/social/drafts/request',answerSchema,{...prepared.payload,commandId:prepared.held.commandId},()=>{if(!current())throw Error('Scope changed');custody.assert(prepared.held);});
  await outcome(answer,prepared.held,current);
 }));
 const reconcile=()=>operation(async current=>custody.exclusive(async()=>{
  if(!current())return;const attempt=custody.read();if(!attempt)return;
  const answer=await client.request('/social/drafts/request/receipt',socialGuidedRequestReceiptSchema,{commandId:attempt.commandId,payloadSHA256:attempt.payloadSHA256},()=>{if(!current())throw Error('Scope changed');custody.assert(attempt);});
  if(!current())return;if(answer.state==='unknown'){setNotice('Social request outcome UNKNOWN. Replacement requests remain held. No retry, reconstructed payload or polling.');return;}
  await outcome(answer.state==='accepted'?{status:'accepted',replayed:true,result:answer.result}:{status:'refused',replayed:true,reason:answer.reason},attempt,current);
 }));
 if(client.current?.status!=='signed_in')return null;
 const disabled=busy||blocked||pending!==null||client.current.role!=='admin';
 return <section aria-label="Guided social suggestion request" className="social-details">
  <h3>Request a guided private suggestion</h3><p>Use your explicitly selected saved style guide and current approved social facts only. Guidance is untrusted style, not factual support or consent. Existing generation readiness and budgets still apply. No source acquisition, publishing or LinkedIn action.</p>
  <p role="status">{notice}</p><button type="button" disabled={disabled} onClick={()=>{void read();}}>Read current generation inputs</button>
  {guide?.state==='available'?<div><label><input type="checkbox" checked={guideSelected} disabled={disabled} onChange={event=>setGuideSelected(event.target.checked)}/>Use saved voice guide {guide.guideId} revision {guide.revision}</label><ul>{guide.entries.map(entry=><li key={entry.entryId}>{entry.dimension}: {entry.guidance}</li>)}</ul></div>:guide?<p>No available saved guide. Curate and save a guide below, then read inputs again.</p>:null}
  {workspace?<fieldset disabled={disabled}><legend>Select approved factual inputs</legend>{workspace.facts.filter(fact=>fact.socialInput?.sanitized).map(fact=><label className="block" key={fact.id}><input type="checkbox" checked={facts.includes(fact.id)} onChange={event=>setFacts(value=>event.target.checked?[...value,fact.id]:value.filter(id=>id!==fact.id))}/>{fact.text} · Fact {fact.id} version {fact.version} · {fact.socialInput?.topic} · {fact.socialInput?.status}{fact.socialInput?.sourceRef?` · Public original ${fact.socialInput.sourceRef.id} revision ${fact.socialInput.sourceRef.revision}`:''}</label>)}{!workspace.facts.some(fact=>fact.socialInput?.sanitized)?<p>No current approved social facts. No freeform factual input is accepted here.</p>:null}</fieldset>:null}
  <button type="button" disabled={disabled||!guideSelected||facts.length===0} onClick={()=>{void dispatch();}}>Request guided social suggestion</button>
  {pending?<aside aria-label="Pending guided social request"><p>Pending request command {pending.commandId}. Navigation preserves UNKNOWN. No resend control.</p><button type="button" disabled={busy||blocked||client.current.role!=='admin'} onClick={()=>{void reconcile();}}>Reconcile guided request receipt</button></aside>:null}
  {requestId?<button type="button" disabled={disabled} onClick={()=>{void operation(current=>currentRequest(requestId,current));}}>Read current requested suggestion</button>:null}
 </section>;
}
