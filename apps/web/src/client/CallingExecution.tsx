import {useEffect,useMemo,useRef,useState,type JSX} from 'react';
import {CALL_ANNOUNCEMENT,callingIdentityListSchema,type CallingIdentityDto} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import type {CallingContextData} from './CallingContext.tsx';
import {CallingExecutionCustody,type CallingExecutionPending} from './CallingExecutionPending.ts';
import {CallingExecutionController,type CallingExecutionLink,type CallingExecutionState,type CallingExecutionPorts} from './CallingExecutionDispatch.ts';
import {CallingReadiness} from './CallingReadiness.tsx';
const idle:CallingExecutionState={phase:'idle',message:'No browser call started. Raw observations support manual reporting only.',muted:false,link:null};
export function CallingExecution({client,context,paused,onBlockedChange,onLinkChange,isScopeCurrent,ports}:{client:BrowserClient;context:CallingContextData|null;paused:boolean;onBlockedChange:(blocked:boolean)=>void;onLinkChange:(link:CallingExecutionLink|null)=>void;isScopeCurrent:()=>boolean;ports?:CallingExecutionPorts}):JSX.Element{
 const [state,setState]=useState(idle),[held,setHeld]=useState<CallingExecutionPending|null>(null),[error,setError]=useState(false),[routeId,setRoute]=useState(''),[identityId,setIdentity]=useState(''),[identities,setIdentities]=useState<CallingIdentityDto[]>([]),[attested,setAttested]=useState(false),[recovering,setRecovering]=useState(false);
 const mounted=useRef(false),scope=useRef(context),callbacks=useRef({onBlockedChange,onLinkChange,isScopeCurrent});scope.current=context;callbacks.current={onBlockedChange,onLinkChange,isScopeCurrent};
 const custody=useMemo(()=>new CallingExecutionCustody(client),[client]);
 const controller=useMemo(()=>new CallingExecutionController(custody,next=>{if(mounted.current&&client.current?.status==='signed_in')setState(next);},ports),[custody,client,ports]);
 useEffect(()=>{mounted.current=true;const refresh=():void=>{try{setHeld(custody.read());}catch{setError(true);}};refresh();const storage=custody.subscribe(refresh);let epoch=client.epoch;
  const session=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;controller.dispose();setState(idle);setHeld(null);setIdentities([]);setAttested(false);callbacks.current.onLinkChange(null);callbacks.current.onBlockedChange(false);}});
  return()=>{mounted.current=false;controller.dispose();storage();session();};
 },[client,controller,custody]);
 useEffect(()=>{controller.dispose();setState(previous=>previous.phase==='terminal'&&previous.link?.firmId===(context?.entry.subject.kind==='firm'?context.entry.subject.firmId:null)?previous:idle);setRoute('');setAttested(false);return()=>{controller.dispose();};},[context,controller]);
 const selectedFirmId=context?.entry.subject.kind==='firm'?context.entry.subject.firmId:null;
 const exactLink=state.link?.firmId===selectedFirmId?state.link:null;
 useEffect(()=>{onLinkChange(exactLink);},[exactLink,onLinkChange]);
 useEffect(()=>{setIdentity('');setIdentities([]);if(!selectedFirmId)return;
  let active=true;const epoch=client.epoch,current=():boolean=>active&&scope.current?.entry.subject.kind==='firm'&&scope.current.entry.subject.firmId===selectedFirmId&&client.isCurrent(epoch)&&client.current?.status==='signed_in';
  void client.request('/calling-identities',callingIdentityListSchema,undefined,()=>{if(!current())throw Error('Calling source changed');}).then(answer=>{if(current()){const session=client.current;if(session?.status!=='signed_in')return;const own=answer.identities.filter(i=>i.ownerUserId===session.userId&&i.disabledAt===null&&(i.enabled||i.verificationStatus==='unverified'));setIdentities(own);setIdentity(own.find(i=>i.usedForCalls)?.id??'');}},()=>{if(current())setIdentities([]);});
  return()=>{active=false;};
 },[client,selectedFirmId]);
 const live=['starting','ringing','connected'].includes(state.phase),blocked=error||held!==null||live,wrapBlocked=error||live||held!==null&&!exactLink;
 useEffect(()=>{onBlockedChange(wrapBlocked);},[wrapBlocked,onBlockedChange]);
 const read=context?.firm?.read,firm=read?.visibility==='assigned_or_admin'?read.firm:null;
 const canonical=context?.entry.subject.kind==='firm'&&!!firm;
 const start=():void=>{if(!canonical||!firm||!attested||paused||blocked)return;const route=firm.phoneRoutes.find(r=>r.id===routeId);if(!route||!identityId)return;const original=context;setAttested(false);void controller.start({firmId:firm.id,routeId:route.id,routeVersion:route.version,callingIdentityId:identityId,...(route.contactId?{contactId:route.contactId}:{})},()=>scope.current===original&&callbacks.current.isScopeCurrent());};
 const recoveryCurrent=():boolean=>mounted.current&&client.current?.status==='signed_in'&&scope.current?.entry.subject.kind==='firm'&&scope.current.entry.subject.firmId===held?.firmId&&callbacks.current.isScopeCurrent();
 const recover=async():Promise<void>=>{if(recovering||!recoveryCurrent())return;setRecovering(true);await controller.recover(recoveryCurrent);if(mounted.current)setRecovering(false);};
 const resolve=async():Promise<void>=>{if(recovering||!exactLink||!recoveryCurrent())return;setRecovering(true);try{await controller.resolveHandoff(recoveryCurrent);}catch{setError(true);}finally{if(mounted.current)setRecovering(false);}};
 return <section className="calling-execution workspace-glass" aria-label="Browser call execution"><h2>Browser call</h2><p>Use your computer microphone and speakers. A headset is not required by this interface. Device and browser permissions still apply.</p><p role="status">{state.message}</p>
 {held?<p>{exactLink?'This terminated call remains reserved for its exact Firm and explicit disposition. Finish the handoff deliberately after recording or deciding not to report.':'One call is active or UNKNOWN for this signed-in identity. Return to its exact canonical Firm to check the receipt.'} No replacement call or automatic reconnect is allowed.</p>:null}
 {error?<p role="alert">Execution storage unavailable. Calls are blocked, no replacement command is created.</p>:null}
 {state.phase==='connected'?<p><strong>Say when they answer:</strong> {CALL_ANNOUNCEMENT}</p>:null}
 {live?<div className="calling-inline"><button onClick={()=>controller.stop()}>Hang up / abandon setup</button>{state.phase!=='starting'?<button aria-pressed={state.muted} onClick={()=>controller.mute()}>{state.muted?'Unmute':'Mute'}</button>:null}</div>:null}
 {held&&!live?<button disabled={recovering||error||selectedFirmId!==held.firmId} onClick={()=>{void recover();}}>Check exact call receipt</button>:null}
 {exactLink?<div><p>Finishing releases this reservation and removes the session link from any unsaved report. It does not save an outcome.</p><button disabled={recovering||error} onClick={()=>{void resolve();}}>Finish terminated call handoff</button></div>:null}
 {canonical?<fieldset disabled={blocked||paused}><label>Exact recorded phone route<select aria-label="Browser call route" value={routeId} onChange={e=>setRoute(e.target.value)}><option value="">Choose recorded route</option>{firm?.phoneRoutes.map(route=><option key={route.id} value={route.id}>{route.value} · {route.eligibility} · version {route.version}</option>)}</select></label><label>Your calling identity<select aria-label="Browser calling identity" value={identityId} onChange={e=>setIdentity(e.target.value)}><option value="">Choose your own number</option>{identities.map(identity=><option key={identity.id} value={identity.id}>{identity.e164}</option>)}</select></label><CallingReadiness client={client} firmId={firm.id} route={firm.phoneRoutes.find(r=>r.id===routeId)??null} identityId={identityId} disabled={blocked||paused} isScopeCurrent={isScopeCurrent}/><p>This calling route records both sides from answer. No call is made without current server eligibility and an explicit click.</p><label className="calling-check"><input type="checkbox" checked={attested} onChange={e=>setAttested(e.target.checked)}/>I am authorized to place and record this call, and want to allow microphone access.</label><button disabled={!attested||!routeId||!identityId} onClick={start}>Call in browser</button></fieldset>:<p>Choose an explicitly assigned canonical Firm with a current recorded route to use browser Calling. Retained observations are not automatically linked or dialed.</p>}
 </section>;
}
