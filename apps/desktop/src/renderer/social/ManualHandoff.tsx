import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {SocialManualHandoffView,SocialManualHandoffSnapshot} from '@fss/contracts';

type Answer<T>={ok:true;value:T}|{ok:false;reason:string};
export interface ManualHandoffPorts {
 read(input:{postId:string;expectedRevision:number}):Promise<Answer<SocialManualHandoffView>>;
 confirm(input:{postId:string;expectedRevision:number;fingerprint:string;reviewedDestination:true}):Promise<Answer<{approvalId:string}>>;
 use(input:{postId:string;expectedRevision:number;fingerprint:string;approvalId:string;action:'copy'|'open'|'save_image';image?:{assetId:string;version:number}}):Promise<void>;
}
type Image=SocialManualHandoffSnapshot['images'][number];
const reasons:Record<string,string>={schedule_in_past:'Time missed. Reschedule and approve this post again.',stale_revision:'This post changed. Review its current version.',approval_changed:'The destination or content changed. Review it again.',image_unavailable:'An image is no longer available. Review this post again.',inspect_existing_submission:'Inspect the existing platform submission before preparing a replacement.',manual_handoff_not_draft:'This post is not available for a new manual handoff.',destination_disconnected:'This destination was disconnected.',facebook_page_required:'Choose a Facebook Page.',content_needs_edit:'Edit the post to fit ordinary platform limits.'};

/** Isolated review/copy UI. Every external affordance refreshes server authority;
 * neither clipboard nor browser ports can schedule or submit a post. */
export function SocialManualHandoff({postId,revision,ports,renderImage}:{postId:string;revision:number;ports:ManualHandoffPorts;renderImage?:(image:Image,onReady:()=>void)=>ReactNode}){
 const [view,setView]=useState<SocialManualHandoffView|null>(null),[reviewed,setReviewed]=useState(false),[readyImages,setReadyImages]=useState<string[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
 const generation=useRef(0),latest=useRef(ports);latest.current=ports;
 const input={postId,expectedRevision:revision};
 useEffect(()=>{const lifetime=generation;const g=++lifetime.current;setView(null);setReviewed(false);setReadyImages([]);setBusy(false);setMessage(null);void latest.current.read({postId,expectedRevision:revision}).then(answer=>{if(generation.current!==g)return;if(answer.ok)setView(answer.value);else setMessage(reasons[answer.reason]??'Manual handoff is unavailable.');}).catch(()=>{if(generation.current===g)setMessage('Could not refresh manual handoff.');});return()=>{lifetime.current++;};},[postId,revision]);
 const refresh=async()=>{if(busy)return;const g=++generation.current;setBusy(true);setView(null);setReviewed(false);setReadyImages([]);setMessage(null);try{const answer=await latest.current.read(input);if(g!==generation.current)return;if(answer.ok)setView(answer.value);else setMessage(reasons[answer.reason]??'Manual handoff is unavailable.');}catch{if(g===generation.current)setMessage('Could not refresh manual handoff.');}finally{if(g===generation.current)setBusy(false);}};
 const refusal=(reason:string)=>{setView(null);setReviewed(false);setReadyImages([]);setMessage(reasons[reason]??'Manual handoff needs review again.');};
 const confirm=async()=>{if(!view||busy||!reviewed)return;const g=generation.current;setBusy(true);try{const answer=await latest.current.confirm({...input,fingerprint:view.fingerprint,reviewedDestination:true});if(g!==generation.current)return;if(!answer.ok){refusal(answer.reason);return;}const current=await latest.current.read(input);if(g!==generation.current)return;if(!current.ok){refusal(current.reason);return;}if(current.value.fingerprint!==view.fingerprint||current.value.approvalId!==answer.value.approvalId){refusal('approval_changed');return;}setView(current.value);}catch{if(g===generation.current)setMessage('No definite answer. Refresh this handoff before copying.');}finally{if(g===generation.current)setBusy(false);}};
 const performHandoff=async(action:'copy'|'open'|'save_image',image?:Image)=>{if(!view||busy)return;const g=generation.current;setBusy(true);try{const current=await latest.current.read(input);if(g!==generation.current)return;if(!current.ok){refusal(current.reason);return;}if(current.value.state!=='manual_needed'||current.value.fingerprint!==view.fingerprint||current.value.approvalId!==view.approvalId){refusal('approval_changed');return;}if(!current.value.approvalId){refusal('approval_changed');return;}await latest.current.use({...input,fingerprint:current.value.fingerprint,approvalId:current.value.approvalId,action,...(image?{image:{assetId:image.assetId,version:image.version}}:{})});if(g===generation.current)setMessage(action==='copy'?'Text copied. Publication remains manual.':action==='save_image'?'Reviewed image saved. Attach it and its alt text manually.':'Composer opened. Publication remains manual.');}catch{if(g===generation.current)setMessage('Handoff did not complete. Callie has not published this post.');}finally{if(g===generation.current)setBusy(false);}};
 const imagesReady=!!view&&view.snapshot.images.every(image=>readyImages.includes(`${image.assetId}:${image.version}:${image.sha256}`));
 return <section aria-label='Manual social handoff' className='space-y-3 rounded-md border p-4'>
  <h3>Manual publication needed</h3><p>Callie has not scheduled or published this post.</p>
  {message&&<p role='status'>{message}</p>}
  <button disabled={busy} onClick={()=>void refresh()}>Refresh handoff</button>
  {view&&<>
   <p>{view.snapshot.account.displayName} · {view.snapshot.account.platform} · {view.snapshot.account.accountKind} · {view.snapshot.account.externalId}</p>
   <p>Destination requires your review. Provider permissions are not verified by this handoff.</p>
   <p className='whitespace-pre-wrap'>{view.snapshot.text}</p>
   <p>Requested time: {new Intl.DateTimeFormat(undefined,{timeZone:view.snapshot.zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(view.snapshot.publishAt))} · {view.snapshot.zone}</p>
   {view.snapshot.images.map(image=><div key={`${view.fingerprint}:${image.assetId}:${image.version}`}>
    {renderImage?.(image,()=>setReadyImages(old=>[...old,`${image.assetId}:${image.version}:${image.sha256}`]))}
    <p>{image.altText} · image version {image.version}</p>{view.state==='manual_needed'&&<button disabled={busy||!imagesReady} onClick={()=>void performHandoff('save_image',image)}>Save reviewed image</button>}
   </div>)}
   {view.snapshot.images.length>0&&<p>Attach these exact reviewed images and alt text manually. Copying text does not attach images.</p>}
   {view.state==='review_required'?<>
    <label><input type='checkbox' checked={reviewed} disabled={busy} onChange={event=>setReviewed(event.target.checked)}/>I reviewed the exact destination, text, images and requested time.</label>
    <button disabled={busy||!reviewed||!imagesReady} onClick={()=>void confirm()}>Approve manual handoff</button>
   </>:<><button disabled={busy||!imagesReady} onClick={()=>void performHandoff('copy')}>Copy approved text</button><button disabled={busy||!imagesReady} onClick={()=>void performHandoff('open')}>Open platform composer</button></>}
  </>}
 </section>;
}
