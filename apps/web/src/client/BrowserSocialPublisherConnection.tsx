import {useLayoutEffect,useRef,useState,type JSX} from 'react';
import {socialPublisherConnectionResultSchema,type SocialPublisherConnectionInput,type SocialPublisherConnectionResult} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';

export interface BrowserSocialPublisherConnectionProps {
 client:BrowserClient;
 transport:(input:SocialPublisherConnectionInput,current:()=>void)=>Promise<SocialPublisherConnectionResult>;
 onConnected?:()=>void;
 reconnectAccountId?:string;
 onDisconnected?:()=>void;
}
/** Credentials and login frames exist only in this mounted authenticated view. */
export function BrowserSocialPublisherConnection({client,transport,onConnected,reconnectAccountId,onDisconnected}:BrowserSocialPublisherConnectionProps):JSX.Element|null {
 const [connection,setConnection]=useState<{id:string;expiresAt:string}|null>(null);
 const [frame,setFrame]=useState<string|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const mounted=useRef(false),token=useRef<symbol|null>(null),binding=useRef(client);binding.current=client;
 useLayoutEffect(()=>{
  mounted.current=true;let epoch=client.epoch;
  const clear=()=>{token.current=null;setConnection(null);setFrame(null);setText('');setBusy(false);setMessage('');};
  clear();
  const unsubscribe=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;clear();}});
  return()=>{mounted.current=false;token.current=null;unsubscribe();};
 },[client]);
 const send=async(input:SocialPublisherConnectionInput)=>{
  if(token.current||client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  const operation=Symbol('publisher-connection'),epoch=client.epoch;token.current=operation;setBusy(true);setMessage('');
  const current=()=>{if(!mounted.current||binding.current!==client||token.current!==operation||!client.isCurrent(epoch)||client.current?.status!=='signed_in'||client.current.role!=='admin')throw new Error('Connection superseded');};
  try{
   const result=socialPublisherConnectionResultSchema.parse(await transport(input,current));current();
   if(result.state==='connecting'){setConnection({id:result.connectionId,expiresAt:result.expiresAt});setFrame(null);setMessage('Connection started. Read the sign-in screen to continue.');}
   else if(result.state==='frame')setFrame(`data:image/jpeg;base64,${result.image}`);
   else if(result.state==='connected'){setConnection(null);setFrame(null);setText('');setMessage(`Verified ${result.displayName} (${result.externalId}). Connection alone does not activate publication.`);onConnected?.();}
   else {setConnection(null);setFrame(null);setText('');setMessage('Connection closed. Existing remote schedules are not recalled by disconnecting.');if(input.operation==='disconnect')onDisconnected?.();}
  }catch{
   try{current();setFrame(null);setMessage('The sign-in screen is unavailable or has completed. If sign-in finished, choose Verify intended account. Expired/lost connections need a new connection; existing remote schedules remain unchanged.');}catch{/* Auth change must not project a late private response. */}
  }finally{
   try{current();token.current=null;setBusy(false);setText('');}catch{/* Cleared by invalidation. */}
  }
 };
 if(client.current?.status!=='signed_in'||client.current.role!=='admin')return null;
 return <section className="social-details" aria-label="LinkedIn publisher connection">
  <h3>Connect your personal LinkedIn account</h3>
  <p>Sign in to your intended account in Callie's private browser. Login input is sent only to this bounded LinkedIn connection, never saved in command history. Browser session credentials are encrypted privately. Connecting does not activate a plan or publish a post.</p>
  <p>This connection supports personal LinkedIn scheduling, inspection and cancellation. An expired runner/session cannot recall an existing remote schedule.</p>
  {reconnectAccountId?<button type="button" disabled={busy} onClick={()=>{setFrame(null);setText('');void send({operation:'disconnect',accountId:reconnectAccountId});}}>Disconnect account (remote schedules remain)</button>:null}
  {!connection?<button type="button" disabled={busy} onClick={()=>{void send({operation:'start',accountId:reconnectAccountId??crypto.randomUUID()});}}>{reconnectAccountId?'Reconnect intended account':'Start private sign-in'}</button>:<>
   <p>Private connection expires at {connection.expiresAt}. Never paste session cookies or a borrowed browser session.</p>
   <button type="button" disabled={busy} onClick={()=>{void send({operation:'frame',connectionId:connection.id});}}>Read sign-in screen</button>
   <button type="button" disabled={busy} onClick={()=>{setFrame(null);void send({operation:'complete',connectionId:connection.id});}}>Verify intended account</button>
   <button type="button" disabled={busy} onClick={()=>{setConnection(null);setFrame(null);setText('');void send({operation:'abort',connectionId:connection.id});}}>Close private connection</button>
   {frame?<img src={frame} width={1280} height={900} className="social-publisher-frame" alt="Private LinkedIn sign-in screen; click the intended field before entering text below" draggable={false} onClick={event=>{
    if(busy)return;const bounds=event.currentTarget.getBoundingClientRect();
    const x=Math.max(0,Math.min(1279,Math.floor((event.clientX-bounds.left)*1280/bounds.width)));
    const y=Math.max(0,Math.min(899,Math.floor((event.clientY-bounds.top)*900/bounds.height)));
    void send({operation:'input',connectionId:connection.id,event:{kind:'click',x,y}});
   }}/>:null}
   <label>Private text for the selected sign-in field<input type="password" autoComplete="off" value={text} maxLength={2000} disabled={busy} onChange={event=>setText(event.target.value)}/></label>
   <button type="button" disabled={busy||!text} onClick={()=>{const value=text;setText('');void send({operation:'input',connectionId:connection.id,event:{kind:'text',text:value}});}}>Enter private text</button>
   {(['Tab','Enter','Backspace','Escape'] as const).map(key=><button key={key} type="button" disabled={busy} onClick={()=>{void send({operation:'input',connectionId:connection.id,event:{kind:'key',key}});}}>{key}</button>)}
   <button type="button" disabled={busy} onClick={()=>{void send({operation:'input',connectionId:connection.id,event:{kind:'scroll',deltaY:600}});}}>Scroll sign-in down</button>
  </>}
  {busy?<p role="status">Working on the private connection…</p>:null}
  {message?<p role="status">{message}</p>:null}
 </section>;
}
