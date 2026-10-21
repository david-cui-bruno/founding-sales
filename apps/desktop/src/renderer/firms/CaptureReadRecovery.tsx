import { useEffect, useRef, useState } from 'react';
import type { CrmCaptureReadRecoveryPayload, CrmCaptureReadRecoveryStatus } from '@fss/contracts';
export interface CaptureReadRecoveryPorts {
 read(input:{mailboxId:string}):Promise<CrmCaptureReadRecoveryStatus>;
 request(input:CrmCaptureReadRecoveryPayload & {commandId:string}):Promise<{attemptId:string;state:string;sendingUnchanged:true;holdsUnchanged:true}>;
}
export function CaptureReadRecovery({ports,mailboxId,privacyKey}:{ports:CaptureReadRecoveryPorts;mailboxId:string;privacyKey:string}){
 const [status,setStatus]=useState<CrmCaptureReadRecoveryStatus|null>(null),[busy,setBusy]=useState(false),[submitted,setSubmitted]=useState(false),[notice,setNotice]=useState('');
 const epoch=useRef(0),dispatching=useRef(false);
 useEffect(()=>{const lifecycle=epoch;const ticket=++lifecycle.current;dispatching.current=false;setStatus(null);setSubmitted(false);setNotice('');setBusy(true);
  void ports.read({mailboxId}).then(value=>{if(ticket===epoch.current)setStatus(value);}).catch(()=>{if(ticket===epoch.current)setNotice('Capture recovery status unavailable.');}).finally(()=>{if(ticket===epoch.current)setBusy(false);});
  return ()=>{++lifecycle.current;};
 },[ports,mailboxId,privacyKey]);
 async function refresh(){const ticket=++epoch.current;setBusy(true);try{const value=await ports.read({mailboxId});if(ticket===epoch.current)setStatus(value);}catch{if(ticket===epoch.current){setStatus(null);setNotice('Capture recovery status unavailable.');}}finally{if(ticket===epoch.current)setBusy(false);}}
 async function request(){
  if(dispatching.current||submitted||busy||!status?.eligible||!status.generation||!status.incidentId||!status.recoveryBinding)return;
  dispatching.current=true;const ticket=++epoch.current;setSubmitted(true);setBusy(true);setNotice('');
  try{
   await ports.request({mailboxId,expectedGeneration:status.generation,incidentId:status.incidentId,expectedRecoveryBinding:status.recoveryBinding,commandId:globalThis.crypto.randomUUID()});
   if(ticket!==epoch.current)return;
   const value=await ports.read({mailboxId});if(ticket===epoch.current)setStatus(value);
  }catch{if(ticket===epoch.current){setStatus(null);setNotice('Outcome not confirmed. Refresh status only. Do not repeat the probe.');}}
  finally{if(ticket===epoch.current)setBusy(false);}
 }
 return <section aria-label="Capture read recovery"><h3>Capture read recovery</h3><p>One read-only provider check for already-approved forward conversation capture. Sending stays paused and every existing sending hold remains unchanged. This check does not prove message coverage.</p>{status?<><p>Incident: {status.incidentId??'unavailable'}</p><p role="status">{status.attempt?.state??(status.eligible?'Ready for one deliberate check':'Unavailable')}{status.reason?`: ${status.reason.replaceAll('_',' ')}`:''}</p>{status.attempt?.state==='verified'?<p>Capture-read verified. Forward capture is separate and remains subject to current consent, exclusions and budgets. Sending remains held.</p>:null}</>:null}{notice?<p role="alert">{notice}</p>:null}<button type="button" disabled={busy||submitted||!status?.eligible} onClick={()=>void request()}>Recover capture read</button><button type="button" disabled={busy} onClick={()=>void refresh()}>Refresh capture recovery status</button></section>;
}
