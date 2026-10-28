import {useEffect,useRef,useState,type JSX} from 'react';
import type {BrowserClient} from './BrowserClient.ts';
import {requestCallingMicrophone} from './CallingVoiceDevice.ts';
/** Local access check only. The existing microphone owner always stops acquired
 * tracks, including a late permission response after unmount or identity change. */
export function CallingMicrophoneCheck({client}:{client:BrowserClient}):JSX.Element{
 const mounted=useRef(false),running=useRef(false),generation=useRef(0);
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[signedIn,setSignedIn]=useState(client.current?.status==='signed_in');
 useEffect(()=>{
  mounted.current=true;generation.current++;let epoch=client.epoch;
  const unsubscribe=client.subscribe(()=>{setSignedIn(client.current?.status==='signed_in');if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;generation.current++;running.current=false;setBusy(false);setNotice('');}});
  return()=>{mounted.current=false;running.current=false;unsubscribe();};
 },[client]);
 const check=async():Promise<void>=>{
  if(running.current||client.current?.status!=='signed_in')return;
  const mine=++generation.current,epoch=client.epoch;
  const current=()=>mounted.current&&generation.current===mine&&client.isCurrent(epoch)&&client.current?.status==='signed_in';
  running.current=true;setBusy(true);setNotice('Checking microphone access…');
  try{await requestCallingMicrophone();if(current())setNotice('Microphone access is available. No call or recording started.');}
  catch{if(current())setNotice('Microphone unavailable. Check your browser permission and try again.');}
  finally{if(current()){running.current=false;setBusy(false);}}
 };
 return <div aria-label="Microphone setup" aria-busy={busy}>
  <div className="calling-inline"><button type="button" disabled={busy||!signedIn} onClick={()=>{void check();}}>Check microphone</button><p>Check access without starting a call or recording.</p></div>
  {notice?<p role="status">{notice}</p>:null}
 </div>;
}
