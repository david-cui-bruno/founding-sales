import {useCallback,useEffect,useRef,useState} from 'react';
import type {ReplyDraftContextInput,ReplyDraftContext,ReplyDraftGenerateInput,ReplyGeneratedDraft,ReplyComposerResult} from '../../../../../packages/contracts/src/replyComposer.ts';
import {replyDraftContextInputSchema} from '../../../../../packages/contracts/src/replyComposer.ts';
import {useSessionEpoch} from '../app/drafts.tsx';
import {useKept} from './kept.ts';
import {Button} from '../ui/button.tsx';

export interface ReplyComposerPorts {
 context(input:ReplyDraftContextInput):Promise<ReplyComposerResult<ReplyDraftContext>>;
 generate(input:Omit<ReplyDraftGenerateInput,'clientVersion'>):Promise<ReplyComposerResult<ReplyGeneratedDraft>>;
}
function selection(messageId:string,envelope:string,refs:string):ReplyDraftContextInput{
 try{const parsed=replyDraftContextInputSchema.safeParse({messageId,...(envelope?{envelope:JSON.parse(envelope)}:{}),...(refs?{factRefs:JSON.parse(refs)}:{})});return parsed.success?parsed.data:{messageId};}catch{return {messageId};}
}
export function ReplyComposer({messageId,ports,enabled=true}:{messageId:string;ports:ReplyComposerPorts;enabled?:boolean}){
 const [text,setText]=useKept(`human-composer:m:${messageId}:text`,'');
 const [base,setBase]=useKept(`human-composer:m:${messageId}:base`,'');
 const [reviewed,setReviewed]=useKept(`human-composer:m:${messageId}:reviewed`,'');
 const [attempt,setAttempt]=useKept(`human-composer:m:${messageId}:attempt`,'');
 const [savedEnvelope,setSavedEnvelope]=useKept(`human-composer:m:${messageId}:envelope`,'');
 const [savedRefs,setSavedRefs]=useKept(`human-composer:m:${messageId}:refs`,'');
 const [context,setContext]=useState<ReplyDraftContext|null>(null);
 const [notice,setNotice]=useState<string|null>(null);
 const [suggestion,setSuggestion]=useState<ReplyGeneratedDraft|null>(null);
 const [generating,setGenerating]=useState(false);
 const epoch=useSessionEpoch(),read=useRef(0);
 const invalidate=useCallback(()=>{read.current++;},[]);
 const latest=useRef({text,base,context,savedEnvelope,savedRefs});latest.current={text,base,context,savedEnvelope,savedRefs};
 const [pending,setPending]=useState(false);
 const refresh=useCallback(async(input?:ReplyDraftContextInput)=>{
  const mine=++read.current;if(!enabled){setContext(null);return null;}setPending(true);
  try{
   let result=await ports.context(input??selection(messageId,latest.current.savedEnvelope,latest.current.savedRefs));if(mine!==read.current)return null;
   const refused=result.ok?null:result.reason;
   if(!result.ok&&['block_changed','block_retired','block_unapproved','not_found'].includes(result.reason)){
    result=await ports.context({messageId});if(mine!==read.current)return null;
   }
   if(result.ok){setContext(result.value);setNotice(refused);return result.value;}
   setContext(null);setNotice(result.reason);return null;
  }catch{if(mine===read.current){setContext(null);setNotice('context_unavailable');}return null;}
  finally{if(mine===read.current)setPending(false);}
 },[messageId,ports,enabled]);
 useEffect(()=>{
  setContext(null);setSuggestion(null);setGenerating(false);void refresh();
  return invalidate;
 },[refresh,epoch,invalidate]);
 const fingerprint=JSON.stringify({text,sourceRevision:base,envelope:savedEnvelope,refs:savedRefs});
 const stale=base!==''?(context===null||base!==context.sourceRevision):text.trim().length>0;
 const bind=(current:ReplyDraftContext)=>{setBase(current.sourceRevision);setSavedEnvelope(JSON.stringify(current.envelope));setSavedRefs(JSON.stringify(current.facts.map(f=>({id:f.id,version:f.version}))));setReviewed('');};
 const adopt=()=>{if(context)bind(context);};
 const reviewExact=async()=>{
  if(!context||stale||!text.trim())return;
  const before=context.sourceRevision,typed=text,envelope=savedEnvelope,refs=savedRefs;
  const current=await refresh();
  if(current?.sourceRevision===before&&latest.current.text===typed&&latest.current.base===before&&latest.current.savedEnvelope===envelope&&latest.current.savedRefs===refs)setReviewed(JSON.stringify({text:typed,sourceRevision:before,envelope,refs}));
 };
 const prepare=async()=>{
  if(!context||stale||generating)return;
  const mine=read.current;
  const commandId=attempt.startsWith(`${context.sourceRevision}:`)?attempt.slice(65):crypto.randomUUID();
  setAttempt(`${context.sourceRevision}:${commandId}`);setGenerating(true);setSuggestion(null);
  try{
   const result=await ports.generate({commandId,messageId,sourceRevision:context.sourceRevision,factRefs:context.facts.map(f=>({id:f.id,version:f.version})),envelope:context.envelope});
   if(mine!==read.current)return;
   if(result.ok){setSuggestion(result.value);setNotice(null);}else setNotice(result.reason);
  }catch{if(mine===read.current)setNotice('generation_outcome_unknown');}
  finally{if(mine===read.current)setGenerating(false);}
 };
 return <section aria-label="Reply composer" className="space-y-3 rounded-md border border-border p-3">
  <h3 className="font-medium">Prepare a reply</h3>
  <p className="text-sm text-muted-foreground">Drafts stay in this signed-in session while you navigate. Review every claim and commitment. Pricing remains undefined until separately approved. This editor does not send.</p>
  {context?<div className="space-y-1 text-sm">
   <p>From: {context.authorAddress}</p><p>To: {context.envelope.to.join(', ')}</p><p>CC: {context.envelope.cc.join(', ')||'None selected'}</p><p>Subject: {context.subject}</p>
   <p>Received To: {context.observedTo.join(', ')||'Unavailable'}</p><p>Received CC: {context.observedCc.join(', ')||'None recorded'}</p>
   <p>Reply-To address metadata is unavailable. The draft uses the verified sender route; verify routing before any future send.</p>
   <p>CC dispatch is a separate feature. These are draft choices only.</p>
   {context.recipientOptions.map(option=><label key={option.address} className="grid gap-1">{option.address} recipient<select className="rounded-md border border-input bg-background p-2" value={context.envelope.to.includes(option.address)?'to':context.envelope.cc.includes(option.address)?'cc':'exclude'} disabled={pending||generating} onChange={event=>{
    const envelope={to:context.envelope.to.filter(address=>address!==option.address),cc:context.envelope.cc.filter(address=>address!==option.address)};
    if(event.target.value==='to')envelope.to.push(option.address);if(event.target.value==='cc')envelope.cc.push(option.address);
    if(!base)bind(context);setSavedEnvelope(JSON.stringify(envelope));setReviewed('');setSuggestion(null);
    void refresh({...selection(messageId,JSON.stringify(envelope),savedRefs),factRefs:context.facts.map(f=>({id:f.id,version:f.version}))});
   }}><option value="exclude" disabled={option.address===context.senderAddress}>Exclude</option><option value="to">To</option><option value="cc" disabled={option.address===context.senderAddress}>CC</option></select></label>)}
   <p>Conversation: {context.providerThreadId}</p><p>Replying to message: <span>{context.inReplyTo}</span></p>
   <fieldset className="space-y-2"><legend>Approved facts for this draft</legend>{context.availableFacts.map(fact=>{
    const checked=context.facts.some(selected=>selected.id===fact.id&&selected.version===fact.version);
    return <label key={fact.id} className="flex gap-2"><input type="checkbox" checked={checked} disabled={!enabled||pending||generating||!checked&&context.facts.length>=20} onChange={event=>{
     const refs=context.facts.filter(selected=>selected.id!==fact.id).map(selected=>({id:selected.id,version:selected.version}));
     if(event.target.checked)refs.push({id:fact.id,version:fact.version});
     if(!base)bind(context);setSavedRefs(JSON.stringify(refs));setReviewed('');setSuggestion(null);
     void refresh({messageId,envelope:context.envelope,factRefs:refs});
    }}/><span>Approved {fact.kind} · version {fact.version}: {fact.text}</span></label>;
   })}</fieldset>
   {!context.facts.length?<p>No approved facts selected. Unsupported claims and commitments require your review.</p>:null}
  </div>:<p role="status">Conversation context unavailable{notice?`: ${notice}`:'.'}</p>}
  {stale?<p role="alert">Your draft is stale. Compare it with the current conversation and facts. Your text is retained.</p>:null}
  <label className="grid gap-1 text-sm">Reply draft<textarea className="rounded-md border border-input bg-background p-2" maxLength={12000} value={text} onChange={event=>{setText(event.target.value);setReviewed('');if(!base&&context)bind(context);}}/></label>
  <div className="flex gap-2">
   <Button size="sm" variant="quiet" disabled={!enabled||pending} onClick={()=>void refresh()}>Refresh reply context</Button>
   {stale&&context?<Button size="sm" variant="quiet" disabled={pending} onClick={adopt}>Use current context</Button>:null}
   <Button size="sm" disabled={!enabled||pending||!context||stale||!text.trim()} onClick={()=>void reviewExact()}>Review exact draft</Button>
   <Button size="sm" disabled={!enabled||pending||generating||!context||stale} onClick={()=>void prepare()}>Prepare suggestion</Button>
  </div>
  {suggestion?<section aria-label="Reply suggestion" className="space-y-2 rounded-md border border-border p-3">
   <p className="whitespace-pre-wrap text-sm">{suggestion.text}</p>
   <ul className="text-sm">{suggestion.reviewNotes.map((note,index)=><li key={index}>{note}</li>)}</ul>
   <Button size="sm" variant="quiet" disabled={!context||context.sourceRevision!==suggestion.sourceRevision||stale} onClick={()=>{if(context){setText(suggestion.text);bind(context);setSuggestion(null);}}}>Use suggestion</Button>
  </section>:null}
  {notice&&context?<p role="status">Suggestion unavailable: {notice}. Your draft is retained.</p>:null}
  {reviewed===fingerprint&&!stale?<p role="status">Reviewed exact draft. Editing it requires another review.</p>:null}
  <p className="text-xs text-muted-foreground">Review confirms your judgment about this exact draft, including unsupported claims and commitments. It does not approve shared facts or authorize sending.</p>
 </section>;
}
