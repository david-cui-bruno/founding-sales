import {useEffect,useMemo,useRef,useState,type JSX} from 'react';
import type {BrowserClient} from './BrowserClient.ts';
import {CallingPreparationCustody,CALLING_PREPARATION_CUSTODY_CHANGED} from './CallingPreparationCustody.ts';
import {companySaveRefusal} from './CallingPreparationMessages.ts';
/** Original-save recovery is selection independent and returns only history.
 * Never read another choice, open a Firm, replay or manufacture a replacement.
 */
export function CallingSaveRecovery({client,localCandidateId}:{client:BrowserClient;localCandidateId?:string|undefined}):JSX.Element|null{
 const custody=useMemo(()=>new CallingPreparationCustody(client),[client]),mounted=useRef(false),running=useRef(false),generation=useRef({value:0}),epoch=client.epoch;
 const [pending,setPending]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),[notice,setNotice]=useState('');
 const [candidateId,setCandidateId]=useState<string|null>(null);
 useEffect(()=>{
  const operation=generation.current;operation.value++;mounted.current=true;running.current=false;setBusy(false);setNotice('');const update=()=>{try{const held=custody.read();setPending(held!==null);setCandidateId(held?.candidateId??null);}catch{setError(true);}};update();const stop=client.subscribe(update);window.addEventListener(CALLING_PREPARATION_CUSTODY_CHANGED,update);window.addEventListener('storage',update);
  return()=>{mounted.current=false;operation.value++;stop();window.removeEventListener(CALLING_PREPARATION_CUSTODY_CHANGED,update);window.removeEventListener('storage',update);};
 },[client,custody,epoch]);
 const recover=async()=>{
  if(running.current||client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  running.current=true;setBusy(true);const mine=generation.current.value,current=()=>mounted.current&&generation.current.value===mine&&client.isCurrent(epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin';
  try{
   const result=await custody.recover(current);if(!current())return;
   setNotice(result.state==='unknown'?'Save status is still UNKNOWN. No replacement save is allowed.':result.state==='refused'?companySaveRefusal(result.reason):'The original company save was recorded. Review its current kept source or select it from Recorded companies to see which details are still available.');
   setPending(custody.read()!==null);
  }catch{if(current())setNotice('Save status is unavailable. Keep the original save unresolved and try checking its status again.');}
  finally{if(current()){running.current=false;setBusy(false);}}
 };
 if(!pending&&!notice&&!error)return null;
 if(pending&&!notice&&!error&&candidateId===localCandidateId)return null;
 return <section className="calling-setup" aria-label="Company save status" aria-busy={busy}><h2>Company save status</h2>{pending?<><p>A company save is pending or UNKNOWN. Its status can be checked even if the original kept number or source is no longer available.</p><button disabled={busy||error||client.current?.status!=='signed_in'||client.current.role!=='admin'} onClick={()=>{void recover();}}>Check save status</button></>:null}{notice?<p role="status">{notice}</p>:null}{error?<p role="alert">Save status storage is unavailable. Further company saves are blocked.</p>:null}</section>;
}
