import {useCallback,useEffect,useMemo,useRef,useState,type JSX} from 'react';
import {z} from 'zod';
import {socialVoiceReadSchema,socialVoiceReceiptSchema,socialVoiceSavedSchema,socialVoiceEntriesSchema,type SocialVoiceGuide,type SocialVoicePreference,type SocialVoiceSaveInput} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {VoicePreferenceCustody,VOICE_PENDING_KEY,type VoicePending} from './VoicePreferenceCustody.ts';
const saveAnswer=z.union([z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:socialVoiceSavedSchema}),z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string()})]);
const dimensions=['tone','formality','concision','structure','vocabulary','formatting','avoid'] as const;
/** Independent explicit curation. Guided requests separately read saved revisions. */
export function BrowserVoicePreferences({client}:{client:BrowserClient}):JSX.Element{
 const custody=useMemo(()=>new VoicePreferenceCustody(client),[client]);
 const [guide,setGuide]=useState<SocialVoiceGuide|null>(null),[entries,setEntries]=useState<SocialVoicePreference[]>([]),[restarting,setRestarting]=useState(false);
 const [pending,setPending]=useState<VoicePending|null>(null),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false),[notice,setNotice]=useState('Read your private voice guide to begin.');
 const guard=useRef(false),token=useRef(0),mounted=useRef(false),binding=useRef(client.epoch),payload=useRef<{held:VoicePending;input:SocialVoiceSaveInput}|null>(null);
 const reset=():void=>{setGuide(null);setEntries([]);setRestarting(false);payload.current=null;};
 const held=useCallback(():void=>{try{setPending(custody.read());}catch{setBlocked(true);setNotice('Voice custody unavailable. Replacement writes are blocked.');}},[custody]);
 useEffect(()=>{
  mounted.current=true;held();
  const clear=():void=>{if(binding.current!==client.epoch||client.current?.status!=='signed_in'){binding.current=client.epoch;token.current++;guard.current=false;setBusy(false);reset();setPending(null);custody.clear();}};
  const unsubscribe=client.subscribe(clear);
  const changed=(event:StorageEvent):void=>{if(event.key!==VOICE_PENDING_KEY)return;token.current++;guard.current=false;setBusy(false);reset();held();setNotice('Another tab changed voice custody. Read current guide after reconciliation.');};
  window.addEventListener('storage',changed);
  const attemptPayload=payload,operationToken=token;
  return ()=>{mounted.current=false;operationToken.current++;guard.current=false;attemptPayload.current=null;unsubscribe();window.removeEventListener('storage',changed);};
 },[client,custody,held]);
 const operation=async(work:(current:()=>boolean)=>Promise<void>):Promise<void>=>{
  if(guard.current||blocked||client.current?.status!=='signed_in')return;
  guard.current=true;setBusy(true);const id=++token.current,generation=client.epoch;
  const current=()=>mounted.current&&token.current===id&&client.isCurrent(generation)&&client.current?.status==='signed_in';
  try{await work(current);}catch{if(current()){held();setNotice('Voice operation unavailable or outcome unknown. No automatic retry or replacement.');}}
  finally{if(current()){guard.current=false;setBusy(false);}}
 };
 const read=async(current:()=>boolean):Promise<void>=>{
  if(!current())return;reset();
  const result=await client.request('/social/voice-preferences/read',socialVoiceReadSchema,{},()=>{if(!current())throw Error('Scope changed');});
  if(!current())return;setGuide(result.guide);setEntries(result.guide.state==='available'?result.guide.entries:[]);setNotice(result.guide.state==='absent'?'No private voice guide yet.':result.guide.state==='removed'?'Guide removed. Explicit blank restart required.':`Private voice guide revision ${result.guide.revision}. Edits are unsaved until Save.`);
 };
 const outcome=async(answer:z.infer<typeof saveAnswer>,attempt:VoicePending,current:()=>boolean):Promise<void>=>{
  if(!current())return;custody.complete(attempt);setPending(null);payload.current=null;
  if(answer.status==='accepted'){await read(current);if(current())setNotice(`Voice command accepted at revision ${answer.result.revision}. Current guide freshly read.`);}
  else{setNotice(`Voice command refused: ${answer.reason}. No merge or overwrite. Read current guide explicitly.`);}
 };
 const save=(operationKind:SocialVoiceSaveInput['operation'])=>operation(async current=>custody.exclusive(async()=>{
  if(!current()||custody.read()||!guide)throw Error('Read or reconcile first');
  let input:SocialVoiceSaveInput;
  if(operationKind==='create'){if(guide.state!=='absent')throw Error('Guide exists');input={operation:'create',entries};}
  else{if(guide.state==='absent')throw Error('Guide absent');const identity={guideId:guide.guideId,expectedRevision:guide.revision};if(operationKind==='remove')input={operation:'remove',...identity};else{if(operationKind==='restart'&&!restarting)throw Error('Explicit restart required');input={operation:operationKind,...identity,entries};}}
  const prepared=await custody.prepare(input,current);payload.current={held:prepared.held,input:prepared.payload};setPending(prepared.held);
  const answer=await client.request('/social/voice-preferences/save',saveAnswer,{...prepared.payload,commandId:prepared.held.commandId},()=>{if(!current())throw Error('Scope changed');custody.assert(prepared.held);});
  await outcome(answer,prepared.held,current);
 }));
 const reconcile=()=>operation(async current=>custody.exclusive(async()=>{
  if(!current())return;const attempt=custody.read();if(!attempt)return;
  const answer=await client.request('/social/voice-preferences/receipt',socialVoiceReceiptSchema,{commandId:attempt.commandId,payloadSHA256:attempt.payloadSHA256},()=>{if(!current())throw Error('Scope changed');custody.assert(attempt);});
  if(!current())return;if(answer.state==='unknown'){setNotice('Voice outcome UNKNOWN. All replacement writes remain held. No lost prose reconstructed.');return;}
  await outcome(answer.state==='accepted'?{status:'accepted',replayed:true,result:answer.result}:{status:'refused',replayed:true,reason:answer.reason},attempt,current);
 }));
 const retry=()=>operation(async current=>custody.exclusive(async()=>{
  if(!current())return;const attempt=payload.current;if(!attempt)throw Error('Mounted payload unavailable');custody.assert(attempt.held);
  const answer=await client.request('/social/voice-preferences/save',saveAnswer,{...attempt.input,commandId:attempt.held.commandId},()=>{if(!current())throw Error('Scope changed');custody.assert(attempt.held);});await outcome(answer,attempt.held,current);
 }));
 const unavailable=busy||blocked||pending!==null;
 const editable=guide!==null&&(guide.state!=='removed'||restarting);
 const valid=socialVoiceEntriesSchema.safeParse(entries).success;
 return <section aria-label="Private voice preferences" className="space-y-2 rounded-md border p-3">
  <h3>Private voice preferences</h3><p>Explicit human-curated, unverified style instructions, not customer facts, quotations, results, commitments or product truth. Pasted text cannot be verified free of private facts. Guided requests use only explicitly selected saved revisions, never unsaved editor text. No automatic learning from draft edits, training, source fetching, consent or platform activation.</p>
  <p>Only explicit Save stores current guidance. Durable until explicit removal or ordinary owner/workspace erasure. No examples, prose history or 90-day draft expiry. Unsaved edits are lost on refresh.</p>
  <p role="status">{notice}</p>
  <button type="button" disabled={unavailable} onClick={()=>{void operation(read);}}>Read private voice guide</button>
  {guide&&guide.state!=='absent'?<p>Guide {guide.guideId} · Revision {guide.revision} · {guide.state}</p>:null}
  {editable?<div>{entries.map((entry,index)=><fieldset key={entry.entryId} disabled={unavailable}><legend>Preference {index+1}</legend><label>Style dimension <select aria-label={`Style dimension ${index+1}`} value={entry.dimension} onChange={event=>setEntries(value=>value.map(item=>item.entryId===entry.entryId?{...item,dimension:event.target.value as SocialVoicePreference['dimension']}:item))}>{dimensions.map(dimension=><option key={dimension}>{dimension}</option>)}</select></label><label>Style guidance <textarea aria-label={`Style guidance ${index+1}`} maxLength={500} value={entry.guidance} onChange={event=>setEntries(value=>value.map(item=>item.entryId===entry.entryId?{...item,guidance:event.target.value}:item))}/></label><button type="button" onClick={()=>setEntries(value=>value.filter(item=>item.entryId!==entry.entryId))}>Remove preference {index+1}</button></fieldset>)}<button type="button" disabled={unavailable||entries.length>=20} onClick={()=>setEntries(value=>[...value,{entryId:crypto.randomUUID(),dimension:'tone',guidance:''}])}>Add style preference</button><p>{entries.length}/20 entries. Each at most 500 characters / 2000 bytes. Guide at most 10000 bytes.</p><button type="button" disabled={unavailable||!valid} onClick={()=>{void save(guide?.state==='absent'?'create':restarting?'restart':'update');}}>{restarting?'Save explicit voice restart':'Save private voice guide'}</button></div>:null}
  {guide?.state==='available'?<button type="button" disabled={unavailable} onClick={()=>{setEntries([]);void save('remove');}}>Remove entire private voice guide</button>:null}
  {guide?.state==='removed'&&!restarting?<button type="button" disabled={unavailable} onClick={()=>{setEntries([]);payload.current=null;setRestarting(true);setNotice('Blank explicit restart. Author new preferences, then Save explicit voice restart.');}}>Start blank voice guide restart</button>:null}
  {pending?<aside aria-label="Pending voice command"><p>Pending voice command {pending.commandId}. No automatic resend.</p><button type="button" disabled={busy||blocked} onClick={()=>{void reconcile();}}>Reconcile same voice command</button>{payload.current?<button type="button" disabled={busy||blocked} onClick={()=>{void retry();}}>Retry exact same voice command</button>:null}</aside>:null}
 </section>;
}
