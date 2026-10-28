import {useEffect,useMemo,useRef,useState,type JSX} from 'react';
import {callingIdentityListSchema,type CallingIdentityDto,createAudioTestSessionCommandSchema} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {CallingExecutionCustody,type CallingExecutionPending} from './CallingExecutionPending.ts';
import {CallingExecutionController,type CallingExecutionState,type CallingExecutionPorts} from './CallingExecutionDispatch.ts';

const idle:CallingExecutionState={phase:'idle',message:'No audio test has started.',muted:false,link:null};
/** Test recipients stay out of CRM; number entry stays only in this signed-in view. */
export function CallingAudioTest({client,paused,onBlockedChange,ports}:{client:BrowserClient;paused:boolean;onBlockedChange:(blocked:boolean)=>void;ports?:CallingExecutionPorts}):JSX.Element{
 const [number,setNumber]=useState(''),[identityId,setIdentity]=useState(''),[identities,setIdentities]=useState<CallingIdentityDto[]>([]),[state,setState]=useState(idle),[held,setHeld]=useState<CallingExecutionPending|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const active=useRef(false),generation=useRef(0),callbacks=useRef(onBlockedChange);callbacks.current=onBlockedChange;
 const custody=useMemo(()=>new CallingExecutionCustody(client),[client]);
 const controller=useMemo(()=>new CallingExecutionController(custody,next=>{if(active.current&&client.current?.status==='signed_in')setState(next);},ports),[client,custody,ports]);
 useEffect(()=>{
  active.current=true;let epoch=client.epoch;
  const refresh=()=>{try{setHeld(custody.read());}catch{setError(true);}};
  const clear=()=>{generation.current++;controller.dispose();setNumber('');setIdentity('');setIdentities([]);setState(idle);setHeld(null);setBusy(false);setNotice('');setError(false);};
  const readIdentities=()=>{const mine=++generation.current,current=()=>active.current&&mine===generation.current&&client.isCurrent(epoch)&&client.current?.status==='signed_in';
   void client.request('/calling-identities',callingIdentityListSchema,undefined,()=>{if(!current())throw Error('Test view changed');}).then(result=>{if(!current())return;const session=client.current;if(session?.status!=='signed_in')return;const own=result.identities.filter(i=>i.ownerUserId===session.userId&&i.disabledAt===null&&(i.enabled||i.verificationStatus==='unverified'));setIdentities(own);setIdentity(own.find(i=>i.usedForCalls)?.id??'');},()=>{if(current())setNotice('Calling identity unavailable. Reopen Calling to read it again.');});};
  refresh();readIdentities();const storage=custody.subscribe(refresh),session=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;clear();if(client.current?.status==='signed_in'){refresh();readIdentities();}}});
  return()=>{active.current=false;controller.dispose();storage();session();callbacks.current(false);};
 },[client,controller,custody]);
 const live=['starting','ringing','connected'].includes(state.phase),blocked=error||held!==null||live;
 const ownBlocked=error||live||held?.operation==='create_audio_test_session';
 useEffect(()=>{onBlockedChange(ownBlocked);},[ownBlocked,onBlockedChange]);
 const mine=generation.current,current=()=>active.current&&generation.current===mine&&client.current?.status==='signed_in';
 const start=()=>{
  if(blocked||paused||client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  const digits=number.replace(/[\s().-]/gu,''),e164=digits.startsWith('+')?digits:digits.length===10?`+1${digits}`:digits.length===11&&digits.startsWith('1')?`+${digits}`:digits;
  const parsed=createAudioTestSessionCommandSchema.omit({commandId:true,clientVersion:true}).safeParse({e164,callingIdentityId:identityId});
  if(!parsed.success){setNotice('Enter a US phone number and choose your calling identity.');return;}
  setNotice('');setNumber('');void controller.start({purpose:'audio_test',...parsed.data},current);
 };
 const recover=async()=>{if(busy||held?.operation!=='create_audio_test_session')return;setBusy(true);try{await controller.recover(current);}finally{if(current())setBusy(false);}};
 const finish=async()=>{if(busy)return;setBusy(true);try{await controller.resolveHandoff(current);}catch{setError(true);}finally{if(current())setBusy(false);}};
 const admin=client.current?.status==='signed_in'&&client.current.role==='admin';
 return <section className="calling-setup" aria-label="Audio test">
  <h2>Audio test</h2><p>Call someone who is expecting the test. Use your computer microphone and speakers, and check that you can both hear each other.</p>
  <p>The test lasts up to 60 seconds and records both sides from answer. It uses your current calling budget and creates no sales prospect or follow-up.</p>
  <p role="status">{state.message}</p>{notice?<p role="alert">{notice}</p>:null}
  {error?<p role="alert">Calling storage is unavailable. Calls are held so the original attempt can be checked.</p>:null}
  {held&&held.operation!=='create_audio_test_session'?<p>A business call is active or uncertain. Finish that call before an audio test.</p>:null}
  {admin?<fieldset disabled={blocked||paused||busy}><label>Test phone number<input type="tel" aria-label="Test phone number" autoComplete="off" inputMode="tel" maxLength={32} value={number} onChange={e=>setNumber(e.target.value)}/></label><label>Your calling identity<select aria-label="Audio test calling identity" value={identityId} onChange={e=>setIdentity(e.target.value)}><option value="">Choose your own number</option>{identities.map(i=><option key={i.id} value={i.id}>{i.e164}</option>)}</select></label><button disabled={!number.trim()||!identityId} onClick={start}>Start audio test</button></fieldset>:<p>A workspace admin can start an audio test.</p>}
  {live?<div className="calling-inline"><button onClick={()=>controller.stop()}>Hang up / abandon test</button>{state.phase!=='starting'?<button aria-pressed={state.muted} onClick={()=>controller.mute()}>{state.muted?'Unmute':'Mute'}</button>:null}</div>:null}
  {held?.operation==='create_audio_test_session'&&!live?<button disabled={busy||error} onClick={()=>{void recover();}}>Check test call status</button>:null}
  {state.audioTestSessionId?<button disabled={busy||error} onClick={()=>{void finish();}}>Finish audio test</button>:null}
 </section>;
}
