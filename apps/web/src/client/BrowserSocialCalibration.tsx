import {useState,type JSX} from 'react';
import {socialPrivateDraftListSchema,socialPrivateDraftReadSchema,socialVoiceReadSchema,socialCalibrationReadSchema,socialCalibrationFinishSchema,type SocialPrivateDraftView,type SocialVoiceGuide} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {useFounderCommand} from './useFounderCommand.ts';
export function BrowserSocialCalibration({client,onCompleted}:{client:BrowserClient;onCompleted?:()=>void}):JSX.Element{
 const [drafts,setDrafts]=useState<{draftId:string;revision:number}[]>([]),[reviewed,setReviewed]=useState<SocialPrivateDraftView[]>([]),[guide,setGuide]=useState<SocialVoiceGuide|null>(null),[curate,setCurate]=useState(false),[guidance,setGuidance]=useState(''),[completion,setCompletion]=useState<string|null>(null),[nextAfterId,setNextAfterId]=useState<string|null>(null);
 const clear=()=>{setDrafts([]);setReviewed([]);setGuide(null);setGuidance('');setCurate(false);setCompletion(null);setNextAfterId(null);};const command=useFounderCommand(client,'calibration',clear);
 const readPage=async(afterId:string|undefined,current:()=>boolean)=>{
  const list=await client.request('/social/private-drafts/list',socialPrivateDraftListSchema,afterId?{afterId}:{},()=>{if(!current())throw Error('Authority changed');});
  if(!current())return;
  setDrafts(list.drafts.filter(d=>d.kind==='post'&&d.originKind==='suggestion'&&d.availability==='available').map(({draftId,revision})=>({draftId,revision})));
  setNextAfterId(list.nextAfterId);
 };
 const load=()=>command.run(async current=>{clear();const answer=await client.request('/social/calibration/read',socialCalibrationReadSchema,{},()=>{if(!current())throw Error('Authority changed');});if(!current())return;if(answer.completion){setCompletion(answer.completion.completedAt);return;}const voice=await client.request('/social/voice-preferences/read',socialVoiceReadSchema,{},()=>{if(!current())throw Error('Authority changed');});if(!current())return;setGuide(voice.guide);await readPage(undefined,current);});
 const review=(draftId:string)=>command.run(async current=>{const result=await client.request('/social/private-drafts/read',socialPrivateDraftReadSchema,{draftId},()=>{if(!current())throw Error('Authority changed');});if(current())setReviewed(rows=>[...rows.filter(d=>d.draftId!==draftId),result.draft]);});
 const finish=()=>{const examples=reviewed.filter(d=>d.availability==='available').map(({draftId,revision})=>({draftId,revision}));const expectedGuide=guide?.state==='available'?{guideId:guide.guideId,revision:guide.revision}:null;const finalGuide=curate&&guide?{...(guide.state==='absent'?{operation:'create' as const}:{operation:guide.state==='removed'?'restart' as const:'update' as const,guideId:guide.guideId,expectedRevision:guide.revision}),entries:[{entryId:crypto.randomUUID(),dimension:'tone' as const,guidance}]}:undefined;const input=socialCalibrationFinishSchema.parse({examples,expectedGuide,...(finalGuide?{finalGuide}:{})});void command.send(input,()=>onCompleted?.());};
 return <section aria-label="Founder calibration">
  <h3>Calibration</h3><p>Review three ordinary private drafts from three distinct requests and formats. Correct them in the private composer if needed, then reread the exact current revisions here. A cosmetic edit is not required. Acceptance means voice, factual accuracy and willingness to publish those exact revisions, privately; this never publishes or enables a plan.</p>
  <p role="status">{command.notice}</p><button disabled={command.disabled} onClick={()=>void load()}>Read calibration and private examples</button>
  {completion?<p>Voice calibration accepted {completion}. Later example expiry does not undo this historical acceptance.</p>:<>
   {drafts.map(d=><button key={d.draftId} disabled={command.disabled||reviewed.length>=3&&!reviewed.some(r=>r.draftId===d.draftId)} onClick={()=>void review(d.draftId)}>Review current draft {d.draftId.slice(0,8)}</button>)}
   {nextAfterId?<button disabled={command.disabled} onClick={()=>void command.run(current=>readPage(nextAfterId,current))}>Next private drafts page</button>:null}
   <p>Reviewed {reviewed.length} of 3 exact revisions. Reviewed selections remain while paging through the private library.</p>
   {reviewed.map(d=><article key={d.draftId}><h4>Exact revision {d.revision}</h4>{d.availability==='available'?<p style={{whiteSpace:'pre-wrap'}}>{d.text}</p>:<p>Unavailable: {d.reason}</p>}<button disabled={command.disabled} onClick={()=>setReviewed(rows=>rows.filter(r=>r.draftId!==d.draftId))}>Remove from reviewed three</button></article>)}
   <label><input type="checkbox" disabled={command.disabled||!guide} checked={curate} onChange={e=>{setCurate(e.target.checked);setGuidance('');}}/>Explicitly curate final tone guidance in the same completion</label>
   {curate?<label>Final tone instructions (replace current guide; no example prose)<textarea disabled={command.disabled} maxLength={500} value={guidance} onChange={e=>setGuidance(e.target.value)}/></label>:null}
   <p>Optional final curation deliberately erases guide-dependent examples under ordinary lifecycle rules, in the same atomic acceptance. Only opaque IDs/revisions and resulting guide reference remain, not a training corpus.</p>
   <button disabled={command.disabled||reviewed.length!==3||reviewed.some(d=>d.availability!=='available')||!guide||(curate&&!guidance.trim())} onClick={finish}>Accept voice, facts and willingness for these exact three revisions</button>
  </>}
  {command.pending?<button disabled={command.busy} onClick={()=>void command.reconcile()}>Reconcile same calibration command</button>:null}
 </section>;
}
