import {useEffect,useRef,useState} from 'react';
import {operations} from '../app/bridges.ts';
/** Only a validated PNG data URL crosses IPC. Images are fetched when their card is visible. */
export function SocialImage({assetId,version,alt,onReady}:{assetId:string;version:number;alt:string;onReady?:()=>void}) {
 const element=useRef<HTMLDivElement>(null),[preview,setPreview]=useState<{key:string;url:string}|null>(null);
 const key=`${assetId}:${version}`;
 useEffect(()=>{
  let current=true,started=false;
  const load=()=>{if(started)return;started=true;const api=operations();if(!api)return;void api.read('social.thumbnail',{assetId,version}).then(result=>{if(current&&result.preview)setPreview({key,url:result.preview});}).catch(()=>{});};
  const node=element.current;
  const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){load();observer?.disconnect();}});
  if(observer&&node)observer.observe(node);else load();
  return()=>{current=false;observer?.disconnect();};
 },[assetId,version,key]);
 return <div ref={element} className="min-h-16">{preview?.key===key?<img className="max-h-64 max-w-full rounded-md object-contain" src={preview.url} alt={alt} onLoad={onReady}/>:<p className="text-xs text-muted-foreground">Image preview unavailable</p>}</div>;
}
