import {useEffect,useRef,useState} from 'react';
import type {SocialImageChoose,SocialImageEdit,SocialImageImportView} from '../../shared/socialImages.ts';
import {operations} from '../app/bridges.ts';
import {Button} from '../ui/button.tsx';
import {Input} from '../ui/input.tsx';
type Rect=NonNullable<SocialImageEdit['crop']>;
interface Ports {
 paste?(input:{usageNote:string|null}):Promise<SocialImageImportView>;
 fromUrl?(input:{url:string;usageNote:string|null}):Promise<SocialImageImportView>;
 state():Promise<SocialImageImportView>;choose(input:SocialImageChoose):Promise<SocialImageImportView>;
 edit(input:SocialImageEdit):Promise<SocialImageImportView>;
 upload(input:{id:string}):Promise<SocialImageImportView>;
 discard(input:{id:string}):Promise<SocialImageImportView>;
}
const defaults:Ports={
 paste:async input=>{const api=operations();if(!api)throw new Error('offline');return api.command('social.pasteImage',input);},
 fromUrl:async input=>{const api=operations();if(!api)throw new Error('offline');return api.command('social.imageFromUrl',input);},
 state:async()=>{const api=operations();if(!api)throw new Error('offline');return api.read('social.imageStage',{});},
 choose:async input=>{const api=operations();if(!api)throw new Error('offline');return api.command('social.chooseImage',input);},
 edit:async input=>{const api=operations();if(!api)throw new Error('offline');return api.command('social.editImage',input);},
 upload:async input=>{const api=operations();if(!api)throw new Error('offline');return api.command('social.uploadImage',input);},
 discard:async input=>{const api=operations();if(!api)throw new Error('offline');return api.command('social.discardImage',input);},
};
function explanation(reason:string|null){
 if(!reason)return null;
 if(reason==='upload_interrupted'||reason==='offline')return 'Upload interrupted. Your image is saved here; retry when connected.';
 if(reason==='remove_failed')return 'Removal could not be confirmed. Your image is still here; try again.';
 if(reason==='clipboard_empty')return 'Copy an image first, then choose Paste image.';
 if(reason==='upload_started')return 'This upload has started. Retry it before making another version.';
 if(reason==='invalid_crop_or_cover')return 'Keep the crop inside the image and each cover inside the crop.';
 if(reason==='finish_current_image')return 'Save or discard this image before choosing another.';
 if(reason==='session_changed')return 'Your account changed. Reopen the image library.';
 return 'The image could not be prepared. Use a still PNG, JPEG, WebP or HEIC under 20 MB.';
}
export function ImageEditor({ports=defaults,onSaved}:{ports?:Ports;onSaved:(assetId:string)=>void}){
 const [view,setView]=useState<SocialImageImportView>({stage:null,reason:null,savedAssetId:null});
 const [busy,setBusy]=useState(true),[dirty,setDirty]=useState(false),[loaded,setLoaded]=useState(false),[previewRevision,setPreviewRevision]=useState(0);
 const [crop,setCrop]=useState<Rect>({x:0,y:0,width:1,height:1}),[covers,setCovers]=useState<Rect[]>([]);
 const [kind,setKind]=useState<SocialImageChoose['kind']>('upload'),[note,setNote]=useState(''),[url,setUrl]=useState('');
 const live=useRef(0),portsRef=useRef(ports);portsRef.current=ports;
 const accept=(answer:SocialImageImportView)=>{
  setView(answer);setLoaded(false);setPreviewRevision(v=>v+1);setDirty(false);
  if(answer.stage){setCrop(answer.stage.crop??{x:0,y:0,width:answer.stage.baseWidth,height:answer.stage.baseHeight});setCovers(answer.stage.redactions);}
 };
 useEffect(()=>{const generation=++live.current;void portsRef.current.state().then(answer=>{if(live.current===generation)accept(answer);}).catch(()=>{if(live.current===generation)setView({stage:null,reason:'offline',savedAssetId:null});}).finally(()=>{if(live.current===generation)setBusy(false);});return()=>{live.current=generation+1;};},[]);
 const act=async(work:()=>Promise<SocialImageImportView>)=>{
  if(busy)return;const generation=live.current;setBusy(true);
  try{const answer=await work();if(live.current!==generation)return;accept(answer);if(answer.savedAssetId)onSaved(answer.savedAssetId);}
  catch{if(live.current===generation)setView(value=>({...value,reason:'upload_interrupted'}));}
  finally{if(live.current===generation)setBusy(false);}
 };
 const stage=view.stage;
 const fields=(rect:Rect,change:(rect:Rect)=>void,prefix:string)=><div className="grid grid-cols-4 gap-2">{(['x','y','width','height'] as const).map(key=><label key={key} className="text-xs text-muted-foreground">{key}<Input type="number" aria-label={`${prefix} ${key}`} min={key==='width'||key==='height'?1:0} max={4096} value={rect[key]} onChange={event=>{setDirty(true);change({...rect,[key]:Number(event.target.value)});}}/></label>)}</div>;
 return <section className="space-y-4 rounded-xl border border-border p-4" aria-label="Prepare an image">
  {explanation(view.reason)&&<p role="status" className="text-sm">{explanation(view.reason)}</p>}
  {!stage?<><div className="flex flex-wrap gap-3"><label className="text-sm">Image type <select aria-label="Image type" value={kind} onChange={event=>setKind(event.target.value as SocialImageChoose['kind'])}><option value="upload">Image</option><option value="phone">Phone photo</option><option value="screenshot">Product screenshot</option></select></label><Input aria-label="Image note" placeholder="Image note (optional)" maxLength={1000} value={note} onChange={event=>setNote(event.target.value)}/></div><Button disabled={busy} onClick={()=>void act(()=>portsRef.current.choose({kind,usageNote:note.trim()||null}))}>Choose image</Button> <Button variant="outline" disabled={busy||!portsRef.current.paste} onClick={()=>void act(()=>portsRef.current.paste!({usageNote:note.trim()||null}))}>Paste image</Button><div className="flex gap-2"><Input aria-label="Image URL" placeholder="https://… direct image URL" value={url} maxLength={2048} onChange={event=>setUrl(event.target.value)}/><Button variant="outline" disabled={busy||!url.startsWith('https://')||!portsRef.current.fromUrl} onClick={()=>void act(()=>portsRef.current.fromUrl!({url,usageNote:note.trim()||null}))}>Preview URL</Button></div><p className="text-xs text-muted-foreground">Choose a file from your Mac, including photos shared from your phone. Your original is preserved.</p></>:<>
   <img key={previewRevision} src={stage.preview} alt="Image being prepared" className="max-h-80 max-w-full rounded-lg object-contain" onLoad={()=>setLoaded(true)} onError={()=>setLoaded(false)}/>
   <fieldset disabled={busy||stage.locked} className="space-y-4"><legend className="mb-2 text-sm font-medium">Crop</legend>{fields(crop,setCrop,'Crop')}
    <p className="text-xs text-muted-foreground">Original preview: {stage.baseWidth} × {stage.baseHeight}. Cover coordinates start at the cropped image’s top left.</p>
    {covers.map((cover,index)=><div key={index} className="space-y-2"><p className="text-sm">Opaque cover {index+1}</p>{fields(cover,value=>setCovers(rows=>rows.map((row,i)=>i===index?value:row)),`Cover ${index+1}`)}<Button variant="ghost" onClick={()=>{setCovers(rows=>rows.filter((_row,i)=>i!==index));setDirty(true);}}>Remove cover {index+1}</Button></div>)}
    <div className="flex gap-2"><Button variant="outline" disabled={covers.length>=100} onClick={()=>{setCovers(rows=>[...rows,{x:0,y:0,width:Math.min(40,crop.width),height:Math.min(20,crop.height)}]);setDirty(true);}}>Add opaque cover</Button><Button variant="outline" onClick={()=>void act(()=>portsRef.current.edit({id:stage.id,crop,redactions:covers}))}>Preview edits</Button></div>
   </fieldset>
   {dirty&&<p className="text-sm">Preview your changes before saving.</p>}
   <div className="flex gap-2"><Button disabled={busy||dirty||!loaded} onClick={()=>void act(()=>portsRef.current.upload({id:stage.id}))}>{stage.locked?'Retry upload':'Save to library'}</Button><Button variant="ghost" disabled={busy} onClick={()=>void act(()=>portsRef.current.discard({id:stage.id}))}>Discard image</Button></div>
  </>}
 </section>;
}
