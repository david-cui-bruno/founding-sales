import type {AnswerBlock,OutreachMutation,SaveAnswerBlock} from '@fss/contracts';

export type FactDraft=SaveAnswerBlock;
interface Props {
 blocks:readonly AnswerBlock[];
 draft:FactDraft;
 blocked:boolean;
 refreshRequired:boolean;
 onChange(draft:FactDraft):void;
 onBegin(draft:FactDraft):void;
 onAdopt(version:number):void;
 onMutate(input:OutreachMutation):void;
}
const status=(block:AnswerBlock)=>block.retiredAt?'Retired':block.approvedAt?'Approved':'Draft';

export function ApprovedFactsEditor({blocks,draft,blocked,refreshRequired,onChange,onBegin,onAdopt,onMutate}:Props){
 const current=blocks.find(block=>block.id===draft.id);
 const changed=current!==undefined&&current.version!==draft.expectedVersion;
 return <fieldset className="space-y-3">
  <legend className="font-medium">Approved answer facts</legend>
  <p className="text-sm text-muted-foreground">Write exact facts, FAQ answers and approved booking or material links using the matching fact type. Unsupported claims need your review and explicit approval. Pricing remains undefined until separately approved. Saving a draft does not approve it or authorize sending or publication.</p>
  <label className="grid gap-1 text-sm">Fact type<select className="rounded-md border border-input bg-background p-2 text-sm max-w-full" value={draft.kind} disabled={blocked} onChange={e=>onChange({...draft,kind:e.target.value as FactDraft['kind']})}>{['product','pricing','booking','material'].map(kind=><option key={kind}>{kind}</option>)}</select></label>
  <label className="grid gap-1 text-sm">Answer fact<textarea className="rounded-md border border-input bg-background p-2" maxLength={4000} value={draft.text} disabled={blocked} onChange={e=>onChange({...draft,text:e.target.value})}/></label>
  {['product','pricing'].includes(draft.kind)&&<>
   <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!draft.socialInput} disabled={blocked} onChange={e=>{if(e.target.checked)onChange({...draft,socialInput:{topic:'build',status:'planned',sanitized:true}});else{const {socialInput:_social,...plain}=draft;onChange(plain);}}}/>Sanitized LinkedIn factual input</label>
   {draft.socialInput&&<fieldset className="space-y-2" aria-label="LinkedIn factual scope">
    <p className="text-xs text-muted-foreground">Approve only your actual public-safe facts, not private conversations, customer details or confidential code. Style is not evidence. Saving or approving does not publish.</p>
    <label className="grid text-sm">LinkedIn topic<select value={draft.socialInput.topic} disabled={blocked} onChange={e=>onChange({...draft,socialInput:{topic:e.target.value as NonNullable<SaveAnswerBlock['socialInput']>['topic'],status:e.target.value==='news'?'observation':draft.socialInput!.status,sanitized:true}})}>{['founder','build','technical','maintenance','news'].map(t=><option key={t}>{t}</option>)}</select></label>
    <label className="grid text-sm">Work status<select value={draft.socialInput.status} disabled={blocked} onChange={e=>onChange({...draft,socialInput:{...draft.socialInput!,status:e.target.value as NonNullable<SaveAnswerBlock['socialInput']>['status']}})}>{['planned','local','shipped','observation'].map(t=><option key={t}>{t}</option>)}</select></label>
    {draft.socialInput.topic==='news'&&<>
     <p role="status">News-source selection is unavailable in this browser. A current checked first-party original is required. Use a supported source workflow before preparing news facts. No source is fetched here.</p>
     {draft.socialInput.sourceRef&&<p className="text-xs">{draft.socialInput.sourceRef.url} · version {draft.socialInput.sourceRef.revision} · checked {draft.socialInput.sourceRef.checkedAt}</p>}
    </>}
   </fieldset>}
  </>}
  {changed?<div className="space-y-2">
   <p role="alert" className="text-sm">Your draft is based on version {draft.expectedVersion}. Compare it with current version {current.version} before saving.</p>
   <section aria-label="Current fact version" className="rounded-md border border-border p-3 space-y-2">
    <p className="text-xs text-muted-foreground">Current · {status(current)} · version {current.version}</p>
    <p className="whitespace-pre-wrap text-sm">{current.text}</p>
   </section>
   <button type="button" disabled={blocked} onClick={()=>onAdopt(current.version)}>Use current version as base</button>
   <p className="text-xs text-muted-foreground">This keeps your typed draft. Saving creates a new unapproved version.</p>
  </div>:refreshRequired?<p role="alert" className="text-sm">Refresh to compare the current fact with your retained draft.</p>:null}
  <button type="button" disabled={blocked||refreshRequired||changed||!draft.text.trim()} onClick={()=>onMutate({action:'fact_save',...draft,commandId:crypto.randomUUID()})}>Save fact draft</button>
  {draft.id?<button type="button" disabled={blocked} onClick={()=>onBegin({kind:'product',text:''})}>New fact</button>:null}
  <ul className="space-y-3">{blocks.map(block=><li key={block.id} className="rounded-md border border-border p-3 space-y-2">
   <p className="whitespace-pre-wrap text-sm">{block.text}</p>
   <p className="text-xs text-muted-foreground">Current · {status(block)} · version {block.version}</p>
   {block.socialInput&&<p className="text-xs">Sanitized LinkedIn input · {block.socialInput.topic} · {block.socialInput.status}{block.socialInput.sourceRef&&<> · {block.socialInput.sourceRef.url} · source version {block.socialInput.sourceRef.revision} · checked {block.socialInput.sourceRef.checkedAt}</>}</p>}
   <div className="flex gap-2">
    <button type="button" disabled={blocked} onClick={()=>onBegin({id:block.id,expectedVersion:block.version,kind:block.kind,text:block.text,...(block.socialInput?{socialInput:block.socialInput}:{})})}>Edit fact</button>
    {!block.approvedAt&&!block.retiredAt?<button type="button" disabled={blocked} onClick={()=>onMutate({action:'fact_approve',id:block.id,version:block.version,commandId:crypto.randomUUID()})}>Approve exact text</button>:null}
    {!block.retiredAt?<button type="button" disabled={blocked} onClick={()=>onMutate({action:'fact_retire',id:block.id,version:block.version,commandId:crypto.randomUUID()})}>Retire fact</button>:null}
   </div>
  </li>)}</ul>
 </fieldset>;
}
