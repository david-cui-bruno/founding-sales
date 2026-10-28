import {useEffect,useRef,useState} from 'react';
import type {ManualPhoneChoice} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {dispatchManualProspect} from './ManualProspectDispatch.ts';
/** Reuse existing manual-feedback custody. No phone or source prose is persisted. */
export function useManualPhoneChoice(client:BrowserClient,candidateId:string|undefined,revision:number|undefined,onSaved:()=>void){
 const key=JSON.stringify([candidateId,revision,client.epoch]),latest=useRef(key);latest.current=key;
 const mounted=useRef(false),running=useRef(false),saved=useRef(onSaved);saved.current=onSaved;
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[unknown,setUnknown]=useState(false);
 useEffect(()=>{mounted.current=true;running.current=false;setBusy(false);setNotice('');
  const update=():void=>{try{const held=client.manualProspects.read();setUnknown(held!==null&&!held.receipt);}catch{setUnknown(true);}};
  update();const unsubscribe=client.subscribe(()=>{if(client.current?.status!=='signed_in'){setNotice('');setBusy(false);}update();});
  return()=>{mounted.current=false;unsubscribe();};
 },[client,key]);
 const epoch=client.epoch;
 const current=():boolean=>mounted.current&&latest.current===key&&client.isCurrent(epoch)&&client.current?.status==='signed_in'&&client.current.role==='admin';
 const run=async(choice:ManualPhoneChoice|null,recover=false):Promise<void>=>{
  if(running.current||!candidateId||!revision||!current())return;
  running.current=true;setBusy(true);setNotice('Saving manual selection…');
  try{
   const held=recover?client.manualProspects.read():client.manualProspects.prepare({candidateId,expectedRevision:revision,state:'kept',phoneChoice:choice});
   if(!held||held.payload.candidateId!==candidateId||held.payload.expectedRevision!==revision)throw Error('Another manual action is pending');
   const message=await dispatchManualProspect(client,held,current);
   if(current()){
    const latestCommand=client.manualProspects.read();setUnknown(latestCommand!==null&&!latestCommand.receipt);setNotice(message);
    if(latestCommand?.receipt)saved.current();
   }
  }catch{if(current()){let unresolved=true;try{const held=client.manualProspects.read();unresolved=held!==null&&!held.receipt;}catch{/* Storage failure keeps custody closed. */}setUnknown(unresolved);setNotice(unresolved?'A manual action is unresolved. Reconcile it before another save.':'Selection could not be saved. Refresh current source details before retrying.');}}
  finally{if(current()){running.current=false;setBusy(false);}}
 };
 return {busy,notice,unknown,save:(choice:ManualPhoneChoice|null)=>{void run(choice);},recover:()=>{void run(null,true);}};
}
