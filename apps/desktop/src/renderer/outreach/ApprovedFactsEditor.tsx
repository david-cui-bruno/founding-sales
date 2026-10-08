import type {AnswerBlock,OutreachMutation,SaveAnswerBlock} from '@fss/contracts';
import {Button} from '../ui/button.tsx';

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
  {changed?<div className="space-y-2">
   <p role="alert" className="text-sm">Your draft is based on version {draft.expectedVersion}. Compare it with current version {current.version} before saving.</p>
   <section aria-label="Current fact version" className="rounded-md border border-border p-3 space-y-2">
    <p className="text-xs text-muted-foreground">Current · {status(current)} · version {current.version}</p>
    <p className="whitespace-pre-wrap text-sm">{current.text}</p>
   </section>
   <Button size="sm" variant="quiet" disabled={blocked} onClick={()=>onAdopt(current.version)}>Use current version as base</Button>
   <p className="text-xs text-muted-foreground">This keeps your typed draft. Saving creates a new unapproved version.</p>
  </div>:refreshRequired?<p role="alert" className="text-sm">Refresh to compare the current fact with your retained draft.</p>:null}
  <Button size="sm" disabled={blocked||refreshRequired||changed||!draft.text.trim()} onClick={()=>onMutate({action:'fact_save',...draft,commandId:crypto.randomUUID()})}>Save fact draft</Button>
  {draft.id?<Button variant="quiet" disabled={blocked} onClick={()=>onBegin({kind:'product',text:''})}>New fact</Button>:null}
  <ul className="space-y-3">{blocks.map(block=><li key={block.id} className="rounded-md border border-border p-3 space-y-2">
   <p className="whitespace-pre-wrap text-sm">{block.text}</p>
   <p className="text-xs text-muted-foreground">Current · {status(block)} · version {block.version}</p>
   <div className="flex gap-2">
    <Button size="sm" variant="quiet" disabled={blocked} onClick={()=>onBegin({id:block.id,expectedVersion:block.version,kind:block.kind,text:block.text})}>Edit fact</Button>
    {!block.approvedAt&&!block.retiredAt?<Button size="sm" disabled={blocked} onClick={()=>onMutate({action:'fact_approve',id:block.id,version:block.version,commandId:crypto.randomUUID()})}>Approve exact text</Button>:null}
    {!block.retiredAt?<Button size="sm" variant="quiet" disabled={blocked} onClick={()=>onMutate({action:'fact_retire',id:block.id,version:block.version,commandId:crypto.randomUUID()})}>Retire fact</Button>:null}
   </div>
  </li>)}</ul>
 </fieldset>;
}
