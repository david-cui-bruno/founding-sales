import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type JSX} from 'react';
import {z} from 'zod';
import {socialDraftViewSchema,socialPrivateDraftListSchema,socialPrivateDraftReadSchema,socialPrivateDraftReceiptSchema,socialPrivateDraftSavedSchema,type SocialDraftView,type SocialPrivateDraftOrigin,type SocialPrivateDraftView,type SocialPrivateDraftList,type SocialPrivateDraftSaveInput} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {PrivateDraftCustody,PRIVATE_DRAFT_PENDING_KEY,privateDraftSHA256,type PrivateDraftPending} from './PrivateDraftCustody.ts';
import './workspaceSocial.css';
export interface PrivateAdoption{request:SocialDraftView;conceptIndex:number;variantIndex:number}
const saveAnswer=z.union([z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:socialPrivateDraftSavedSchema}),z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string()})]);
export function BrowserPrivateComposer({client,adoption,reviewBusy,reviewRevision,onDiscard,autoList=false}:{client:BrowserClient;adoption:PrivateAdoption|null;reviewBusy:boolean;reviewRevision:number;onDiscard:()=>void;autoList?:boolean}):JSX.Element{
 const custody=useMemo(()=>new PrivateDraftCustody(client),[client]);
 const [text,setText]=useState(''),[kind,setKind]=useState<'post'|'comment'>('post'),[origin,setOrigin]=useState<SocialPrivateDraftOrigin>({kind:'manual'});
 const [selected,setSelected]=useState<Extract<SocialPrivateDraftView,{availability:'available'}>|null>(null),[deadline,setDeadline]=useState<string|null>(null);
 const selectedRef=useRef(selected);
 const [list,setList]=useState<SocialPrivateDraftList|null>(null),[pending,setPending]=useState<PrivateDraftPending|null>(null),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false),[notice,setNotice]=useState('Write privately. Only explicit Save stores text.');
 const [editorOpen,setEditorOpen]=useState(false);
 const editor=useRef<HTMLTextAreaElement>(null),listButton=useRef<HTMLButtonElement>(null);
 const focusIntent=useRef<'editor'|'list'|null>(null);
 const openEditor=():void=>{focusIntent.current='editor';setEditorOpen(true);};
 const guard=useRef(false),token=useRef(0),payload=useRef<{held:PrivateDraftPending;input:SocialPrivateDraftSaveInput}|null>(null),binding=useRef(client.epoch);
 const originRef=useRef(origin);originRef.current=origin;const adoptionBlocked=useRef(false);adoptionBlocked.current=pending!==null||blocked;
 const reset=():void=>{setText('');setKind('post');setOrigin({kind:'manual'});selectedRef.current=null;setSelected(null);setDeadline(null);};
 const held=useCallback(():void=>{try{setPending(custody.read());}catch{setBlocked(true);setNotice('Private save custody unavailable. No replacement operation is allowed.');}},[custody]);
 useEffect(()=>{
  held();const clear=():void=>{if(binding.current!==client.epoch||client.current?.status!=='signed_in'){binding.current=client.epoch;token.current++;guard.current=false;setBusy(false);reset();setList(null);setPending(null);payload.current=null;custody.clear();}};
  const unsubscribe=client.subscribe(clear);
  const changed=(event:StorageEvent):void=>{if(event.key===PRIVATE_DRAFT_PENDING_KEY){try{if(event.newValue!==localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY))return;}catch{setBlocked(true);}token.current++;guard.current=false;setBusy(false);if(originRef.current.kind==='suggestion')reset();setList(null);payload.current=null;held();setNotice('Another tab changed private save custody. Manual edits remain unsaved in this page only. Reopen current content explicitly.');}};
  const operationToken=token;window.addEventListener('storage',changed);return ()=>{operationToken.current++;unsubscribe();window.removeEventListener('storage',changed);};
 },[client,custody,held]);
 // Evidence cancellation releases UI ownership, never the held command identity.
 useEffect(()=>{if(originRef.current.kind==='suggestion'){token.current++;guard.current=false;setBusy(false);payload.current=null;reset();held();}},[reviewRevision,held]);
 useEffect(()=>{
  if(adoption===null){if(originRef.current.kind==='suggestion'){token.current++;guard.current=false;setBusy(false);payload.current=null;reset();held();}return;}
  if(guard.current||adoptionBlocked.current)return;
  token.current++;const variant=adoption.request.concepts?.[adoption.conceptIndex]?.variants[adoption.variantIndex];
  if(!variant||Date.parse(adoption.request.deadlineAt)<=Date.now())return;
  openEditor();
  setText(variant.text);setKind('post');selectedRef.current=null;setSelected(null);setDeadline(adoption.request.deadlineAt);setOrigin({kind:'suggestion',requestId:adoption.request.id,conceptIndex:adoption.conceptIndex,variantIndex:adoption.variantIndex,selectionSHA256:'0'.repeat(64)});
  const generation=client.epoch,id=token.current;
  void privateDraftSHA256(JSON.stringify({request:socialDraftViewSchema.parse(adoption.request),conceptIndex:adoption.conceptIndex,variantIndex:adoption.variantIndex})).then(hash=>{if(token.current===id&&client.isCurrent(generation))setOrigin({kind:'suggestion',requestId:adoption.request.id,conceptIndex:adoption.conceptIndex,variantIndex:adoption.variantIndex,selectionSHA256:hash});}).catch(()=>{if(token.current===id)setNotice('Selection fingerprint unavailable. Re-read before saving.');});
  setNotice('Current ready suggestion adopted privately. Provenance is not proof of semantic support. Human review required.');
 },[adoption,client,held]);
 useEffect(()=>{
  if(!deadline)return;let timer:ReturnType<typeof setTimeout>;
  const expire=():void=>{const remaining=Date.parse(deadline)-Date.now();if(remaining>0){timer=setTimeout(expire,Math.min(2147483647,remaining));return;}token.current++;guard.current=false;setBusy(false);reset();setList(null);payload.current=null;setNotice('Selected suggestion or private draft expired. Private adopted scratch cleared. Re-read current evidence.');};
  expire();return ()=>clearTimeout(timer);
 },[deadline]);
 const operation=useCallback(async(work:(current:()=>boolean)=>Promise<void>):Promise<void>=>{
  // Synchronous guard precedes token/preparation, including same-turn double clicks.
  if(guard.current||blocked||client.current?.status!=='signed_in')return;
  guard.current=true;setBusy(true);const id=++token.current,generation=client.epoch;
  const current=()=>token.current===id&&client.isCurrent(generation)&&client.current?.status==='signed_in';
  try{await work(current);}catch{if(current()){held();setNotice('Private operation unavailable or outcome unknown. No automatic replay or replacement save.');}}
  finally{if(current()){guard.current=false;setBusy(false);}}
 },[blocked,client,held]);
 const reopen=async(draftId:string,current:()=>boolean,savedRevision?:number):Promise<void>=>{
  reset();
  const result=await client.request('/social/private-drafts/read',socialPrivateDraftReadSchema,{draftId},()=>{if(!current())throw Error('Scope changed');});
  if(!current())return;
  if(result.draft.draftId!==draftId)throw Error('Selected private draft changed');
  const fresh=result.draft;
  const metadata={draftId:fresh.draftId,revision:fresh.revision,kind:fresh.kind,originKind:fresh.originKind,availability:fresh.availability,createdAt:fresh.createdAt,updatedAt:fresh.updatedAt,expiresAt:fresh.expiresAt};
  // List only server-returned metadata, never excerpts or editor text.
  setList(value=>value?{...value,drafts:value.drafts.map(draft=>draft.draftId===draftId?metadata:draft)}:value);
  if(result.draft.availability==='unavailable'){setNotice(`Private draft unavailable: ${result.draft.reason}. No text restored.`);return;}
  if(Date.parse(result.draft.expiresAt)<=Date.now()){setNotice('Private draft expired.');return;}
  selectedRef.current=result.draft;setSelected(result.draft);setText(result.draft.text);setKind(result.draft.kind);setOrigin(result.draft.origin);setDeadline(result.draft.expiresAt);openEditor();setNotice(savedRevision===undefined?`Private draft reopened at revision ${result.draft.revision}. Human review required.`:`Private draft saved at revision ${savedRevision}. Not approved, scheduled or published.`);
 };
 const outcome=async(answer:z.infer<typeof saveAnswer>,attempt:PrivateDraftPending,current:()=>boolean):Promise<void>=>{
  if(!current())return;custody.complete(attempt);setPending(null);payload.current=null;
  if(answer.status==='accepted'){
   await reopen(answer.result.draftId,current,answer.result.revision);
   if(!current())return;
   const result=await client.request('/social/private-drafts/list',socialPrivateDraftListSchema,{},()=>{if(!current())throw Error('Scope changed');});
   if(current())showList(result);
  }
  else{if(answer.reason!=='stale_revision'||origin.kind==='suggestion')reset();setNotice(`Private save refused: ${answer.reason}. Edits remain unsaved only when manual. Reopen explicitly, no overwrite.`);}
 };
 const save=()=>operation(async current=>custody.exclusive(async()=>{
  if(custody.read())throw Error('Reconcile pending save');
  const input:SocialPrivateDraftSaveInput=selected?{operation:'update',draftId:selected.draftId,expectedRevision:selected.revision,kind,text}:{operation:'create',kind,text,origin};
  const prepared=await custody.prepare(input,current);payload.current={held:prepared.held,input:prepared.payload};setPending(prepared.held);
  const answer=await client.request('/social/private-drafts/save',saveAnswer,{...prepared.payload,commandId:prepared.held.commandId},()=>{if(!current())throw Error('Scope changed');custody.assert(prepared.held);});
  await outcome(answer,prepared.held,current);
 }));
 const reconcile=()=>operation(async current=>custody.exclusive(async()=>{
  const attempt=custody.read();if(!attempt)return;
  const answer=await client.request('/social/private-drafts/receipt',socialPrivateDraftReceiptSchema,{commandId:attempt.commandId,payloadSHA256:attempt.payloadSHA256},()=>{if(!current())throw Error('Scope changed');custody.assert(attempt);});
  if(!current())return;
  if(answer.state==='unknown'){setNotice('Save outcome UNKNOWN. Same command held. No new save or guessed payload allowed.');return;}
  await outcome(answer.state==='accepted'?{status:'accepted',replayed:true,result:answer.result}:{status:'refused',replayed:true,reason:answer.reason},attempt,current);
 }));
 const retry=()=>operation(async current=>custody.exclusive(async()=>{const attempt=payload.current;if(!attempt)throw Error('Lost in-memory payload');custody.assert(attempt.held);const answer=await client.request('/social/private-drafts/save',saveAnswer,{...attempt.input,commandId:attempt.held.commandId},()=>{if(!current())throw Error('Scope changed');custody.assert(attempt.held);});await outcome(answer,attempt.held,current);}));
 const showList=(result:SocialPrivateDraftList):void=>{if(result.drafts.some(draft=>draft.draftId===selectedRef.current?.draftId&&draft.availability==='unavailable')){reset();setNotice('Selected private draft is no longer available. Private text cleared.');}setList(result);};
 useEffect(()=>{
  if(autoList)void operation(async current=>{const result=await client.request('/social/private-drafts/list',socialPrivateDraftListSchema,{},()=>{if(!current())throw Error('Scope changed');});if(current())setList(result);});
 },[client,autoList,operation]);
 const unavailable=busy||reviewBusy||pending!==null||blocked;
 // Focus only committed, enabled targets. A newer transition replaces the intent,
 // so no deferred editor/list callback can steal focus after Back or reopen.
 useLayoutEffect(()=>{
  const intent=focusIntent.current;if(intent===null||(intent==='editor')!==editorOpen)return;
  const target=intent==='editor'?editor.current:listButton.current;
  if(!target?.isConnected||target.disabled)return;
  focusIntent.current=null;target.focus();
 });
 return <section aria-label="Private social composer" aria-busy={busy||reviewBusy} className={`social-composition${editorOpen?' social-editor-open':''}`}>
  <div className="social-composition-toolbar"><div><h3>Private posts & comments</h3><p>Save privately. Nothing is approved, scheduled or published.</p></div>
   <button type="button" disabled={unavailable} onClick={()=>{token.current++;reset();openEditor();setNotice('New blank manual composition. Previous text and provenance cleared.');}}>Start new manual draft</button>
  </div>
  <p role="status" className="social-notice">{notice}</p>
  <div className="social-post-workspace">
  <aside className="social-post-list" aria-label="Saved private drafts">
   <div className="social-list-heading"><h4>Your drafts</h4><button ref={listButton} type="button" disabled={busy||blocked} onClick={()=>{void operation(async current=>{const result=await client.request('/social/private-drafts/list',socialPrivateDraftListSchema,{},()=>{if(!current())throw Error('Scope changed');});if(current())showList(result);});}}>List saved private drafts</button></div>
   {list===null?<p className="social-empty">Load saved drafts to see current private records. Draft text is read only when you reopen one.</p>:<div>{list.drafts.length===0?<p className="social-empty">No saved private drafts. Start a new manual draft.</p>:null}{list.drafts.map(draft=><button className="social-draft-row" key={draft.draftId} type="button" aria-label={`Reopen private draft ${draft.draftId}, ${draft.kind}, revision ${draft.revision}, ${draft.availability}`} aria-pressed={selected?.draftId===draft.draftId} disabled={unavailable} onClick={()=>{void operation(current=>reopen(draft.draftId,current));}}><strong>{draft.kind==='post'?'Post':'Comment'} · Revision {draft.revision}</strong><span>{draft.originKind==='manual'?'Manual':'Retained suggestion'} · {draft.availability}</span><small>Updated <time dateTime={draft.updatedAt}>{draft.updatedAt.slice(0,10)}</time> · {draft.draftId.slice(-8)}</small></button>)}{list.nextAfterId?<button type="button" disabled={busy||blocked} onClick={()=>{void operation(async current=>{const result=await client.request('/social/private-drafts/list',socialPrivateDraftListSchema,{afterId:list.nextAfterId},()=>{if(!current())throw Error('Scope changed');});if(current())showList(result);});}}>Next private drafts</button>:null}</div>}
  </aside>
  <div className="social-selected-editor">
  <button className="social-mobile-back" type="button" onClick={()=>{focusIntent.current='list';setEditorOpen(false);}}>Back to drafts</button>
  <div className="social-editor-heading"><h4>{selected?'Selected private draft':'New private draft'}</h4><span>{selected?`Revision ${selected.revision}${text!==selected.text||kind!==selected.kind?' · Unsaved changes':''}`:'Unsaved'}</span></div>
  <label>Scratch format <select aria-label="Scratch format" value={kind} disabled={unavailable} onChange={e=>setKind(e.target.value==='comment'?'comment':'post')}><option value="post">Post</option><option value="comment">Comment</option></select></label>
  <details className="social-details"><summary>Source, privacy & expiry</summary>
  <p>Explicit Save only. No autosave. Unsaved edits are lost on refresh. Saved private drafts expire 90 days after first save, earlier if source rights expire. Updates do not extend expiry. Not approved, scheduled or published.</p>
  <p>{origin.kind==='manual'?'Manually written scratch.':`Based on a retained generated suggestion. Selected origin request ${origin.requestId}`} All composer prose and edits are unverified and human-review-required. Provenance is not semantic support.</p>
  {origin.kind==='suggestion'?<p>Concept {origin.conceptIndex+1} · Variant {origin.variantIndex+1} · Selection fingerprint {origin.selectionSHA256}</p>:null}
  {selected?<p>Saved private draft {selected.draftId} · Revision {selected.revision} · Created {selected.createdAt} · Updated {selected.updatedAt} · Expires {selected.expiresAt}</p>:null}
  </details>
  <p className="social-expiry">{deadline?`Expires ${deadline}`:'First save starts a maximum 90-day lifetime.'} · Human review required</p>
  <label className="social-copy-field">Private {kind} text<textarea ref={editor} disabled={unavailable} aria-label="Private social text" maxLength={10000} value={text} onChange={e=>setText(e.target.value)}/></label><p className="social-character-count">{text.length}/10000 characters · Never stored in browser storage</p>
  <div className="social-editor-actions">
  <button type="button" disabled={unavailable||!text.trim()||(origin.kind==='suggestion'&&origin.selectionSHA256==='0'.repeat(64))||Date.parse(deadline??'9999-01-01')<=Date.now()} onClick={()=>{void save();}}>Save private draft</button>
  <button type="button" disabled={busy||pending!==null||blocked} onClick={()=>{token.current++;onDiscard();reset();setNotice('Private scratch discarded. Saved server drafts unchanged.');}}>Discard private scratch</button>
  </div></div></div>
  {pending?<aside aria-label="Pending private save"><p>Pending private save {pending.commandId}. Outcome not confirmed. Refresh never resends text.</p><button type="button" disabled={busy||blocked} onClick={()=>{void reconcile();}}>Reconcile same private save</button>{payload.current?<button type="button" disabled={busy||blocked} onClick={()=>{void retry();}}>Retry exact same private save</button>:null}</aside>:null}
 </section>;
}
