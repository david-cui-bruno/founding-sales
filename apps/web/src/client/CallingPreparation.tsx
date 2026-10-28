import {useEffect,useMemo,useRef,useState,useCallback,type JSX} from 'react';
import {callingPreparationReadSchema,callingPreparationInputSchema,type CallingPreparationSelection,type CallingPreparationRead,type CallingPreparationProfile,type CallingPreparationReceipt} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {CallingPreparationCustody,CALLING_PREPARATION_CUSTODY_CHANGED} from './CallingPreparationCustody.ts';
import {CallingPreparationFields} from './CallingPreparationFields.tsx';
import {privateDraftCanonicalJson} from './PrivateDraftCustody.ts';
import {companySaveRefusal} from './CallingPreparationMessages.ts';
type Available=Extract<CallingPreparationRead,{state:'available'}>;
/** Deliberate source-bound creation, separate from both qualification and calling. */
export function CallingPreparation({client,selection,disabled=false,onOpenFirm}:{client:BrowserClient;selection:CallingPreparationSelection;disabled?:boolean;onOpenFirm:(firmId:string,label:string)=>void}):JSX.Element{
 const custody=useMemo(()=>new CallingPreparationCustody(client),[client]),key=JSON.stringify(selection),latest=useRef(key);latest.current=key;
 const mounted=useRef(false),running=useRef(false),generation=useRef({value:0}),epoch=client.epoch;
 const [view,setView]=useState<CallingPreparationRead|null>(null),[profile,setProfile]=useState<CallingPreparationProfile|null>(null),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[storageError,setStorageError]=useState(false),[us,setUs]=useState(false),[ack,setAck]=useState(false),[notice,setNotice]=useState('');
 const [pendingCandidate,setPendingCandidate]=useState<string|null>(null);
 const current=useCallback(()=>mounted.current&&latest.current===key&&client.isCurrent(epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin',[client,epoch,key]);
 const read=async(check:()=>boolean)=>{
  const answer=await client.request('/calling/preparation/read',callingPreparationReadSchema,selection,()=>{if(!check())throw Error('Preparation changed');});
  if(answer.state==='available'&&Date.parse(answer.phone.expiresAt)<=Date.now())throw Error('Preparation expired');
  if(answer.state==='available'&&privateDraftCanonicalJson(answer.selection)!==privateDraftCanonicalJson(selection))throw Error('Selection changed');
  if(check()){setView(answer);setProfile(answer.state==='available'?answer.profile:null);setUs(false);setAck(false);}return answer;
 };
 useEffect(()=>{const operation=generation.current;mounted.current=true;operation.value++;running.current=false;setBusy(false);setView(null);setProfile(null);setNotice('');setUs(false);setAck(false);setStorageError(false);const update=()=>{try{const held=custody.read();setUnknown(held!==null);setPendingCandidate(held?.candidateId??null);}catch{setStorageError(true);}};update();window.addEventListener(CALLING_PREPARATION_CUSTODY_CHANGED,update);window.addEventListener('storage',update);
  const unsubscribe=client.subscribe(()=>{if(!current()){generation.current.value++;running.current=false;setBusy(false);setView(null);setProfile(null);setNotice('Current admin session required.');}});
  return()=>{mounted.current=false;operation.value++;unsubscribe();window.removeEventListener(CALLING_PREPARATION_CUSTODY_CHANGED,update);window.removeEventListener('storage',update);};
 },[client,custody,key,epoch,current]);
 useEffect(()=>{
  if(view?.state!=='available')return;
  const timer=setTimeout(()=>{setView(view.binding?{state:'withdrawn',preparationId:view.binding.preparationId,revision:view.binding.revision,reason:'source_withdrawn'}:{state:'refused',reason:'source_withdrawn'});setProfile(null);setUs(false);setAck(false);},Math.max(0,Math.min(Date.parse(view.phone.expiresAt)-Date.now(),2_147_483_647)));
  return()=>clearTimeout(timer);
 },[view]);
 const run=async(work:(check:()=>boolean)=>Promise<void>)=>{
  if(running.current||!current())return;running.current=true;setBusy(true);const mine=generation.current.value,check=()=>generation.current.value===mine&&current();
  try{await work(check);}catch{if(check())setNotice('Company details unavailable. Review the current source; check save status if a save is UNKNOWN.');}
  finally{if(check()){running.current=false;setBusy(false);try{const held=custody.read();setUnknown(held!==null);setPendingCandidate(held?.candidateId??null);}catch{setStorageError(true);}}}
 };
 const finish=async(answer:CallingPreparationReceipt,check:()=>boolean)=>{
  if(!check())return;
  if(answer.state==='unknown'){setView(null);setProfile(null);setUnknown(true);setNotice('Save status is UNKNOWN. Check this save before making another change.');return;}
  if(answer.state==='refused'){setView(null);setProfile(null);setNotice(companySaveRefusal(answer.reason));return;}
  // Receipt IDs describe history. Only this current read can display a live binding.
  const fresh=await read(check);if(check())setNotice(fresh.state==='available'&&fresh.binding?'Company saved. Open it to review the separate calling checks. No call was started.':'The original save was recorded; its source is now unavailable.');
 };
 const save=()=>run(async check=>{
  if(!view||view.state!=='available'||!profile||!us||!ack||custody.read()||disabled||storageError)return;
  const input=callingPreparationInputSchema.safeParse({selection:view.selection,expected:view.binding?{state:'live',preparationId:view.binding.preparationId,revision:view.binding.revision,routeVersion:view.binding.routeVersion}:{state:'absent'},reviewedProfile:{...profile,countryCode:'US'},acknowledgeUnqualifiedSourceOwnership:true});
  if(!input.success){setNotice('Review the company fields, state code, website and time zone. Leave unknown optional fields blank.');return;}
  setView(null);setNotice('Saving company…');await finish(await custody.confirm(input.data,check),check);
 });
 const available:Available|null=view?.state==='available'?view:null;
 return <section className="calling-preparation" aria-label="Save company for Calling" aria-busy={busy}><h3>Save company for Calling</h3><p>Save an unverified company and this kept number for Calling. Research stays paused. Saving does not qualify the company, grant contact permission or start a call.</p>
 <button disabled={busy||disabled} onClick={()=>{void run(async check=>{setView(null);await read(check);setNotice('Current kept number read. Review the company details and unknowns before saving.');});}}>Review company details</button>
 {notice?<p role="status">{notice}</p>:null}{view?.state==='withdrawn'?<p>Saved company details withdrawn. The retained source is unavailable, so this kept choice cannot be saved again.</p>:view?.state==='refused'?<p>{companySaveRefusal(view.reason)}</p>:null}
 {storageError?<p role="alert">Save status storage is unavailable. Further saves are blocked until the original save can be checked.</p>:null}
 {unknown?<div>{pendingCandidate===selection.candidateId?<><p>A company save is pending or UNKNOWN. Check its status before another save.</p><button disabled={busy||storageError} onClick={()=>{void run(async check=>{setView(null);await finish(await custody.recover(check),check);});}}>Check save status</button></>:<p>Another company's save is unresolved. Use Company save status above to check that save before making another.</p>}</div>:null}
 {available&&profile?<><p><strong>{available.phone.value}</strong> · retained source valid until {new Date(available.phone.expiresAt).toLocaleString()}</p><p>Identity, residential fit, phone type and decision maker remain unverified. Blank office fields and time zone stay unknown.</p>
 {available.duplicates.possibleDuplicateCount?<p role="status">An existing company may already match. Select it from Recorded companies before saving another.</p>:null}
 <form onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy||disabled||unknown||storageError||available.duplicates.possibleDuplicateCount>0}><legend>Review company and office details</legend><CallingPreparationFields profile={profile} onChange={setProfile}/><label className="calling-check"><input type="checkbox" checked={us} onChange={event=>setUs(event.target.checked)}/>I have reviewed that this office is in the United States.</label><label className="calling-check"><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/>Keep these unverified company details and number tied to their retained source. Remove these saved details if the source becomes unavailable, and keep research paused.</label><button className="workspace-primary" type="submit" disabled={!us||!ack}>{available.binding?'Update reviewed details':'Save company'}</button></fieldset></form>
 {available.binding?<button disabled={busy||unknown||disabled} onClick={()=>{void run(async check=>{const fresh=await read(check);if(check()&&fresh.state==='available'&&fresh.binding)onOpenFirm(fresh.binding.firmId,fresh.profile.companyName);});}}>Open company</button>:null}</>:null}
 </section>;
}
