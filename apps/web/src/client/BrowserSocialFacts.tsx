import {useCallback,useEffect,useMemo,useRef,useState,type JSX} from 'react';
import {z} from 'zod';
import {answerBlockSchema,saveAnswerBlockCommandSchema,answerBlockApprovalCommandSchema,uuid,type AnswerBlock,type OutreachMutation,type SaveAnswerBlock} from '@fss/contracts';
import {ApprovedFactsEditor} from '../../../desktop/src/renderer/outreach/ApprovedFactsEditor.tsx';
import type {BrowserClient} from './BrowserClient.ts';
import {BrowserSocialFactsCustody,SOCIAL_FACTS_PENDING_PREFIX} from './BrowserSocialFactsCustody.ts';
const listSchema=z.strictObject({blocks:z.array(answerBlockSchema).max(50)});
const answerSchema=z.union([z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:z.strictObject({id:uuid,version:z.number().int().positive()})}),z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.string()})]);
const empty=():SaveAnswerBlock=>({kind:'product',text:''});
/** The existing shared facts editor, on existing answer-block API owners only.
 * No save implies approval, and no approval implies a preparation or publication. */
export function BrowserSocialFacts({client,onFactsChanged}:{client:BrowserClient;onFactsChanged:()=>void}):JSX.Element|null{
 const custody=useMemo(()=>new BrowserSocialFactsCustody(client),[client]);
 const [blocks,setBlocks]=useState<AnswerBlock[]>([]),[draft,setDraft]=useState<SaveAnswerBlock>(empty);
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[held,setHeld]=useState(false),[refresh,setRefresh]=useState(false);
 const [afterId,setAfterId]=useState<string|undefined>(),[notice,setNotice]=useState('Read current facts to author or approve an exact version.');
 const mounted=useRef(false),token=useRef(0),lock=useRef(false),epoch=useRef(client.epoch),changed=useRef(onFactsChanged);changed.current=onFactsChanged;
 const clear=():void=>{token.current++;lock.current=false;setBusy(false);setBlocks([]);setDraft(empty());setLoaded(false);setRefresh(false);setAfterId(undefined);};
 const readCustody=useCallback(():void=>{try{setHeld(custody.read()!==null);}catch{setHeld(true);}},[custody]);
 useEffect(()=>{
  mounted.current=true;readCustody();
  const unsubscribe=client.subscribe(()=>{if(epoch.current!==client.epoch||client.current?.status!=='signed_in'){epoch.current=client.epoch;clear();}});
  const storageChanged=(event:StorageEvent):void=>{if(event.key===null||event.key.startsWith(SOCIAL_FACTS_PENDING_PREFIX)){clear();readCustody();setNotice('Fact command custody changed. Read current facts. Uncertain writes remain held.');changed.current();}};
  window.addEventListener('storage',storageChanged);
  const owner=token;
  return ()=>{mounted.current=false;owner.current++;lock.current=false;unsubscribe();window.removeEventListener('storage',storageChanged);};
 },[client,custody,readCustody]);
 const operation=async(work:(current:()=>boolean)=>Promise<void>):Promise<void>=>{
  if(lock.current||client.current?.status!=='signed_in'||client.current.role!=='admin')return;
  lock.current=true;setBusy(true);const id=++token.current,generation=client.epoch;
  const current=()=>mounted.current&&token.current===id&&client.isCurrent(generation)&&client.current?.status==='signed_in'&&client.current.role==='admin';
  try{await work(current);}catch{if(current()){readCustody();setBlocks([]);setLoaded(false);setRefresh(true);setNotice('Fact action unavailable or outcome UNKNOWN. No retry or replacement was sent. Read current facts to inspect, not to clear an unknown write.');}}
  finally{if(current()){lock.current=false;setBusy(false);}}
 };
 const readPage=async(current:()=>boolean,after?:string):Promise<AnswerBlock[]>=>{
  const result=await client.request('/outreach/answer-blocks',listSchema,after?{afterId:after}:{},()=>{if(!current())throw Error('Scope changed');});
  if(!current())throw Error('Scope changed');return result.blocks;
 };
 const read=(more=false)=>operation(async current=>{
  const page=await readPage(current,more?afterId:undefined);if(!current())return;
  setBlocks(prior=>more?[...prior,...page.filter(b=>!prior.some(p=>p.id===b.id))]:page);setAfterId(page.length===50?page.at(-1)?.id:undefined);setLoaded(true);setRefresh(false);readCustody();
  setNotice('Current shared facts read. Saving creates an unapproved version. Approval is a separate explicit action.');
 });
 const mutate=(input:OutreachMutation)=>operation(async current=>custody.exclusive(async()=>{
  if(!current()||custody.read()||!loaded||refresh)throw Error('Read current facts first');
  if(input.action!=='fact_save'&&input.action!=='fact_approve'&&input.action!=='fact_retire')throw Error('Unsupported action');
  const {action,...raw}=input;
  // The validation-only default preserves the locked schema's refinement. It is
  // never sent. Only the signed browser gateway injects the trusted version.
  const parsed=action==='fact_save'?saveAnswerBlockCommandSchema.parse({...raw,clientVersion:'0.0.0'}):answerBlockApprovalCommandSchema.parse({...raw,clientVersion:'0.0.0'});
  const {clientVersion:_validationVersion,...payload}=parsed;
  if(action==='fact_save'&&'id' in payload&&payload.id&&blocks.find(b=>b.id===payload.id)?.version!==('expectedVersion' in payload?payload.expectedVersion:undefined))throw Error('Compare current fact version');
  // Clear guided input selections before dispatch. Its existing preparation owner
  // still re-reads exact approved refs and will never silently upgrade a version.
  changed.current();
  const marker=custody.prepare(action,input.commandId);setHeld(true);
  const path=action==='fact_save'?'save':action==='fact_approve'?'approve':'retire';
  const answer=await client.request(`/outreach/answer-blocks/${path}`,answerSchema,payload,()=>{if(!current())throw Error('Scope changed');custody.assert(marker);});
  if(!current())return;
  custody.complete(marker);setHeld(false);setBlocks([]);setLoaded(false);setRefresh(true);
  if(answer.status==='refused'){setNotice('Fact action refused. Read current facts and compare your retained draft before a new explicit action.');return;}
  if(action==='fact_save')setDraft(empty());
  setNotice(`Fact ${answer.result.id} version ${answer.result.version} ${action==='fact_save'?'saved unapproved':action==='fact_approve'?'approved':'retired'}. Read current facts to inspect exact text. No sending or publication activated.`);
 }));
 if(client.current?.status!=='signed_in'||client.current.role!=='admin'||epoch.current!==client.epoch)return null;
 return <section aria-label="Social fact authoring">
  <h2>Shared approved facts</h2>
  <p>Author public-safe factual inputs here, then explicitly approve their exact saved text. In guided preparation, read current generation inputs and select that same fact ID and version. No private source capture or publication occurs here.</p>
  <button type="button" disabled={busy} onClick={()=>{void read();}}>Read current facts</button>
  {afterId?<button type="button" disabled={busy} onClick={()=>{void read(true);}}>Read more current facts</button>:null}
  <p role="status">{notice}</p>
  {held?<p role="alert">A fact write is pending or UNKNOWN, or its custody is unavailable. New fact writes are held. Reading facts does not clear custody or prove an ambiguous write absent. No resend control is available.</p>:null}
  <ApprovedFactsEditor loadPublicSources={null} blocks={blocks} draft={draft} blocked={busy||held||!loaded} refreshRequired={refresh||!loaded}
   onChange={setDraft} onBegin={value=>{setDraft(value);setRefresh(false);}}
   onAdopt={version=>{setDraft(value=>({...value,expectedVersion:version}));setRefresh(false);}}
   onMutate={input=>{void mutate(input);}}/>
 </section>;
}
