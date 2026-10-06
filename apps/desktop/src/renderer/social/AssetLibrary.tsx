import {SocialImage} from './SocialImage.tsx';
import {useEffect, useRef, useState} from 'react';
import type {SocialAssetView} from '@fss/contracts';
import {operations} from '../app/bridges.ts';
import {Button} from '../ui/button.tsx';
import {Input} from '../ui/input.tsx';
export interface AssetLibraryPorts {
 read(afterId?:string): Promise<{assets:SocialAssetView[]|null;reason:string|null}>;
 remove(input:{assetId:string;commandId:string}): Promise<{accepted:boolean;reason:string|null}>;
}
const defaults:AssetLibraryPorts = {
 read:async afterId=>{const api=operations();if(!api)throw new Error('offline');return api.read('social.assets',afterId?{afterId}:{});},
 remove:async input=>{const api=operations();if(!api)throw new Error('offline');return api.command('social.removeAsset',input);},
};
export function AssetLibrary({ports=defaults,onSelect}:{ports?:AssetLibraryPorts;onSelect?:((image:{assetId:string;version:number;altText:string})=>void)|undefined}) {
 const [assets,setAssets]=useState<SocialAssetView[]>([]),[notice,setNotice]=useState<string|null>(null);
 const [busy,setBusy]=useState(false),[descriptions,setDescriptions]=useState<Record<string,string>>({});
 const [cursor,setCursor]=useState<string|null>(null);
 const live=useRef(0),currentPorts=useRef(ports);currentPorts.current=ports;
 const pending=useRef<{assetId:string;commandId:string}|null>(null);
 useEffect(()=>{const generation=++live.current;void currentPorts.current.read().then(result=>{if(live.current!==generation)return;if(result.assets){setAssets(result.assets);setCursor(result.assets.length===50?result.assets.at(-1)!.id:null);}else setNotice('Your image library could not be loaded.');}).catch(()=>{if(live.current===generation)setNotice('Your image library could not be loaded.');});return()=>{live.current=generation+1;};},[]);
 const more=async()=>{
  if(!cursor||busy)return;const generation=live.current;setBusy(true);setNotice(null);
  try{const result=await currentPorts.current.read(cursor);if(live.current!==generation)return;if(result.assets){const page=result.assets;setAssets(rows=>[...new Map([...rows,...page].map(row=>[row.id,row])).values()]);setCursor(page.length===50?page.at(-1)!.id:null);}else setNotice('More images could not be loaded. Try again.');}
  catch{if(live.current===generation)setNotice('More images could not be loaded. Try again.');}
  finally{if(live.current===generation)setBusy(false);}
 };
 const remove=async(assetId:string)=>{
  if(busy)return;const generation=live.current;
  if(pending.current&&pending.current.assetId!==assetId)return;
  const command=pending.current??{assetId,commandId:crypto.randomUUID()};pending.current=command;setBusy(true);setNotice(null);
  try{const result=await currentPorts.current.remove(command);if(live.current!==generation)return;if(result.accepted){setAssets(rows=>rows.filter(row=>row.id!==assetId));pending.current=null;}else{setNotice('The image could not be removed. Try again.');if(!['offline','unreadable_answer'].includes(result.reason??''))pending.current=null;}}
  catch{if(live.current===generation)setNotice('The image could not be removed. Try again.');}
  finally{if(live.current===generation)setBusy(false);}
 };
 return <div className="space-y-4" aria-label="Image library">
  {notice&&<p role="status" className="text-sm">{notice}</p>}
  {assets.length===0&&!notice&&<p className="py-8 text-sm text-muted-foreground">No images in your library yet.</p>}
  {assets.map(asset=>{const derivative=asset.objects.find(object=>object.kind==='derivative'&&object.version===asset.version&&object.state==='ready');return <article key={asset.id} className="space-y-3 rounded-xl border border-border p-4">
   <SocialImage assetId={asset.id} version={asset.version} alt={descriptions[asset.id]||asset.origin.usageNote||'Image preview'}/><p className="text-sm font-medium">{asset.origin.usageNote||'Untitled image'}</p>
   <p className="text-xs text-muted-foreground">{derivative?`${derivative.width} × ${derivative.height}`:'Image preparation pending'}</p>
   {asset.origin.sourceUrl&&<p className="break-all text-xs text-muted-foreground">Source: {asset.origin.sourceUrl}</p>}
   {onSelect&&<label className="block text-sm">Image description<Input aria-label="Image description" value={descriptions[asset.id]??''} onChange={event=>setDescriptions(value=>({...value,[asset.id]:event.target.value}))}/></label>}
   <div className="flex gap-2">{onSelect&&<Button disabled={!derivative||!descriptions[asset.id]?.trim()||busy} onClick={()=>onSelect({assetId:asset.id,version:asset.version,altText:descriptions[asset.id]!.trim()})}>Use image</Button>}
   <Button variant="ghost" disabled={busy||(pending.current!==null&&pending.current.assetId!==asset.id)} onClick={()=>void remove(asset.id)}>Remove image</Button></div>
  </article>;})}
 {cursor&&<Button variant="outline" disabled={busy} onClick={()=>void more()}>Load more images</Button>}
 </div>;
}
