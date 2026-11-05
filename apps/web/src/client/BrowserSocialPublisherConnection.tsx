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
type Channel=Extract<SocialPublisherConnectionResult,{state:'channels'}>['channels'][number];
/** The key exists only in this mounted owner view and the private credential transport. */
export function BrowserSocialPublisherConnection({client,transport,onConnected,reconnectAccountId,onDisconnected}:BrowserSocialPublisherConnectionProps):JSX.Element|null {
 const [channels,setChannels]=useState<Channel[]|null>(null),[selection,setSelection]=useState('');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[hasKey,setHasKey]=useState(false);
 const keyInput=useRef<HTMLInputElement|null>(null),secret=useRef('');
 const mounted=useRef(false),token=useRef<symbol|null>(null),binding=useRef(client);binding.current=client;
 const clearSecret=()=>{secret.current='';if(keyInput.current)keyInput.current.value='';setHasKey(false);};
 useLayoutEffect(()=>{
  mounted.current=true;const input=keyInput.current;let epoch=client.epoch;
  const clear=()=>{token.current=null;clearSecret();setChannels(null);setSelection('');setBusy(false);setMessage('');};
  clear();
  const unsubscribe=client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'||client.current.role!=='admin'){epoch=client.epoch;clear();}});
  return()=>{mounted.current=false;token.current=null;secret.current='';if(input)input.value='';unsubscribe();};
 },[client,reconnectAccountId]);
 const send=async(input:SocialPublisherConnectionInput)=>{
  if(token.current||client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  const operation=Symbol('publisher-connection'),epoch=client.epoch;token.current=operation;setBusy(true);setMessage('');
  const current=()=>{if(!mounted.current||binding.current!==client||token.current!==operation||!client.isCurrent(epoch)||client.current?.status!=='signed_in'||client.current.role!=='admin')throw new Error('Connection superseded');};
  try{
   current();const result=socialPublisherConnectionResultSchema.parse(await transport(input,current));current();
   if(result.state==='channels'&&input.operation==='discover'){
    setChannels(result.channels);setSelection('');
    if(!result.channels.length){clearSecret();setMessage('No eligible personal LinkedIn profiles were found. Check your Buffer connection and permissions, then enter your key again.');}
   }else if(result.state==='connected'&&input.operation==='connect'){
    clearSecret();setChannels(null);setSelection('');setMessage(`Connected ${result.displayName}. Connection alone does not activate publication.`);onConnected?.();
   }else if(result.state==='closed'&&input.operation==='disconnect'){
    clearSecret();setChannels(null);setSelection('');setMessage('Disconnected. Existing remote schedules may remain in Buffer or LinkedIn; disconnecting does not recall them.');onDisconnected?.();
   }else throw new Error('Unexpected connection result');
  }catch{
   try{current();clearSecret();setChannels(null);setSelection('');setMessage('The connection could not be confirmed. Check your Buffer account and key, then deliberately try again. No automatic retry or publication was made. Existing remote schedules remain unchanged.');}catch{/* A changed owner must never receive a late private response. */}
  }finally{
   try{current();token.current=null;setBusy(false);}catch{/* Invalidation already cleared the view. */}
  }
 };
 if(client.current?.status!=='signed_in'||client.current.role!=='admin')return null;
 const selected=channels?.find(channel=>`${channel.organizationId}:${channel.channelId}`===selection);
 return <section className="social-connection" aria-label="LinkedIn publisher connection">
  <h3>Connect with Buffer Free</h3>
  <p>Keep drafting here; Buffer delivers approved posts to your selected personal LinkedIn profile. Connecting never activates publishing.</p>
  <ol className="social-buffer-steps">
   <li><a href="https://publish.buffer.com" target="_blank" rel="noreferrer">Open Buffer</a> and use its Free plan. Connect your intended personal LinkedIn profile in Buffer, not a company page.</li>
   <li>In <a href="https://publish.buffer.com/settings/api" target="_blank" rel="noreferrer">Buffer Settings → API</a>, create your API key. Buffer Free supports one key.</li>
   <li>Enter the key privately below, discover your profiles, then explicitly choose the intended profile and connect.</li>
  </ol>
  <p id="social-buffer-key-scope">Your key can access your whole Buffer account, not just one profile. Callie uses it only for the one profile you select and stores it encrypted on the server. Never paste it into chat. It is not saved in browser storage.</p>
  <form autoComplete="off" onSubmit={event=>{event.preventDefault();if(hasKey&&!busy)void send({operation:'discover',apiKey:secret.current});}}>
   <label>Buffer API key<input ref={keyInput} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" aria-describedby="social-buffer-key-scope" maxLength={4096} disabled={busy} onChange={event=>{secret.current=event.target.value;setHasKey(Boolean(event.target.value));setChannels(null);setSelection('');setMessage('');}}/></label>
   <div className="social-connection-actions"><button type="submit" className="workspace-primary" disabled={busy||!hasKey}>Discover LinkedIn profiles</button></div>
  </form>
  {channels?.length?<fieldset disabled={busy} className="social-buffer-profiles"><legend>Choose your intended personal profile</legend><p>No profile is selected automatically, even if only one is available.</p>
   {channels.map(channel=><label className="social-check" key={`${channel.organizationId}:${channel.channelId}`}><input type="radio" name="buffer-profile" checked={selection===`${channel.organizationId}:${channel.channelId}`} onChange={()=>setSelection(`${channel.organizationId}:${channel.channelId}`)}/><span><strong>{channel.displayName}</strong><small>LinkedIn profile ID: {channel.externalId}</small>{channel.profileUrl?<a href={channel.profileUrl} target="_blank" rel="noreferrer">View profile ↗</a>:null}</span></label>)}
   <button type="button" className="workspace-primary" disabled={!selected||busy} onClick={()=>{if(selected)void send({operation:'connect',accountId:reconnectAccountId??crypto.randomUUID(),apiKey:secret.current,organizationId:selected.organizationId,channelId:selected.channelId});}}>{reconnectAccountId?'Reconnect selected profile':'Connect selected profile'}</button>
  </fieldset>:null}
  {reconnectAccountId?<div className="social-connection-actions"><button type="button" disabled={busy} onClick={()=>{clearSecret();setChannels(null);setSelection('');void send({operation:'disconnect',accountId:reconnectAccountId});}}>Disconnect account (remote schedules remain)</button></div>:null}
  {busy?<p role="status">Checking your explicit Buffer connection request…</p>:null}
  {message?<p role="status">{message}</p>:null}
  <details><summary>Privacy &amp; publication details</summary><p>The key is cleared when setup completes, this view closes, or your signed-in session changes. It is never part of command history.</p><p>Approved posting images use a stable public delivery URL: the exact approved derivative becomes publicly retrievable when handed to Buffer, before its scheduled post, until withdrawal, pause or expiry. This is intentionally public, not a secret or protected link; unlisted does not mean private. Buffer or LinkedIn may retain fetched copies. Private library previews remain signed-in only.</p><p>Connecting does not activate a plan or publish a post. Disconnecting cannot recall existing remote schedules. Uncertain publication outcomes must be inspected, never blindly retried.</p></details>
 </section>;
}
