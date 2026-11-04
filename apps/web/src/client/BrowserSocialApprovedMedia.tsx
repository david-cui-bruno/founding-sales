import {useEffect,useRef,useState,type JSX} from 'react';
import type {ApprovedSocialMedia,SocialMediaApprovalInput} from '@fss/contracts';
export type MediaPoolItem=ApprovedSocialMedia&{approved:boolean};
export interface SocialMediaBrowserPort {
 read():Promise<MediaPoolItem[]>;
 upload(file:File):Promise<void>;
 preview(binding:{assetId:string;version:number;sha256:string}):Promise<{url:string;expiresAt:string}>;
 approve(input:SocialMediaApprovalInput):Promise<void>;
 remove(input:{assetId:string;expectedApprovalRevision:number}):Promise<void>;
 subscribe(clear:()=>void):()=>void;
 reconcile():Promise<'unknown'|'accepted'|'refused'>;
}
/** Only sanitized, signed previews are displayed; the original never gets an object URL. */
export function BrowserSocialApprovedMedia({port}:{port:SocialMediaBrowserPort}):JSX.Element {
 const [items,setItems]=useState<MediaPoolItem[]>([]),[selected,setSelected]=useState<MediaPoolItem|null>(null),[url,setUrl]=useState<string|null>(null),[expiresAt,setExpiresAt]=useState(0);
 const [caption,setCaption]=useState(''),[topic,setTopic]=useState(''),[altText,setAltText]=useState(''),[clearance,setClearance]=useState(false),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('Upload one still image, then inspect and approve the exact sanitized preview.');
 const epoch=useRef(0),locked=useRef(false);
 useEffect(()=>{const generation=epoch;const reset=()=>{generation.current++;locked.current=false;setBusy(false);setItems([]);setSelected(null);setUrl(null);setLoaded(false);setCaption('');setTopic('');setAltText('');setClearance(false);};const unsubscribe=port.subscribe(reset);return()=>{generation.current++;unsubscribe();};},[port]);
 useEffect(()=>{if(!expiresAt)return;const timer=setTimeout(()=>{setUrl(null);setLoaded(false);},Math.max(0,expiresAt-Date.now()));return()=>clearTimeout(timer);},[expiresAt]);
 const action=async(work:(current:()=>boolean)=>Promise<void>)=>{
  if(locked.current)return;locked.current=true;setBusy(true);const id=epoch.current;
  const current=()=>epoch.current===id;
  try{await work(current);}catch{if(current()){setUrl(null);setLoaded(false);setNotice('Action unavailable or outcome unknown. Read current media; do not replace an uncertain command.');}}finally{if(current()){locked.current=false;setBusy(false);}}
 };
 const refreshCurrent=async(current:()=>boolean)=>{const media=await port.read();if(current())setItems(media);};
 const read=()=>action(async current=>{const media=await port.read();if(current()){setItems(media);setSelected(null);setUrl(null);setLoaded(false);setNotice('Current pool read. Upload alone does not approve public use.');}});
 const inspect=(item:MediaPoolItem)=>action(async current=>{const preview=await port.preview(item);if(!current())return;setSelected(item);setCaption(item.caption);setTopic(item.topic);setAltText(item.altText);setClearance(false);setLoaded(false);setUrl(preview.url);setExpiresAt(Date.parse(preview.expiresAt));});
 return <section aria-label="Approved media"><h3>Media</h3><p>One real photo or screenshot. JPEG, PNG, WebP or HEIC, up to 20 MiB and 36 million source pixels. Private originals are deleted after sanitization. Sanitization removes metadata, not sensitive visible content.</p>
  <button disabled={busy} onClick={()=>void read()}>Read current media</button>
  <label>Upload image<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,.heic" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;void action(async current=>{if(file.size>20*1024*1024)throw Error('image_too_large');await port.upload(file);if(current()){await refreshCurrent(current);if(current())setNotice('Sanitized image ready. Inspect the preview before approving.');}});}}/></label>
  <ul>{items.map(item=><li key={item.assetId}><button disabled={busy} onClick={()=>void inspect(item)}>{item.caption||'Unapproved image'} — {item.approved?'approved':'needs approval'}</button></li>)}</ul>
  <button disabled={busy} onClick={()=>void action(async current=>{const state=await port.reconcile();if(current())setNotice(state==='unknown'?'Outcome UNKNOWN. No replacement command is permitted.':`Command ${state}. Read current media before any further change.`);})}>Reconcile uncertain media command</button>
  {selected&&<form onSubmit={event=>{event.preventDefault();if(!loaded||!clearance||!url||Date.now()>=expiresAt)return;void action(async current=>{await port.approve({assetId:selected.assetId,version:selected.version,sha256:selected.sha256,expectedApprovalRevision:selected.approvalRevision,caption,topic,altText,publicUseClearance:true});if(current()){await refreshCurrent(current);if(current()){setSelected(null);setUrl(null);setNotice('Exact sanitized version approved for metadata-based selection.');}}});}}>
   {url&&<img key={`${selected.assetId}:${selected.version}:${selected.sha256}`} src={url} alt="Sanitized image awaiting your accurate alt text" onLoad={()=>setLoaded(true)} onError={()=>setLoaded(false)} style={{maxWidth:'100%',maxHeight:400}}/>}
   <p>Version {selected.version}; {selected.width} × {selected.height}. No date, pose or location is inferred.</p>
   <label>Caption<textarea required maxLength={1000} value={caption} onChange={e=>setCaption(e.target.value)}/></label>
   <label>Topic<input required maxLength={200} value={topic} onChange={e=>setTopic(e.target.value)}/></label>
   <label>Accurate alt text<textarea required maxLength={1000} value={altText} onChange={e=>setAltText(e.target.value)}/></label>
   <label><input type="checkbox" checked={clearance} onChange={e=>setClearance(e.target.checked)}/>I have rights to share this exact preview and explicit public-use clearance for visible people, credentials, customer/tenant information and addresses.</label>
   <button disabled={busy||!loaded||!clearance||!url} type="submit">Approve exact preview for my posts</button>
   <button disabled={busy} type="button" onClick={()=>void action(async current=>{await port.remove({assetId:selected.assetId,expectedApprovalRevision:selected.approvalRevision});if(current()){await refreshCurrent(current);if(current()){setSelected(null);setUrl(null);setNotice('Withdrawn immediately; private object deletion is queued. Existing remote posts are unchanged.');}}})}>Withdraw and remove</button>
  </form>}
  <p role="status">{notice}</p>
 </section>;
}
