import {useState,useEffect,useRef,type JSX} from 'react';
import {z} from 'zod';
import type {StandingBrowserRequest} from './BrowserSocialStandingPlan.tsx';
const previewSchema=z.object({url:z.string().url(),expiresAt:z.iso.datetime()}).strict();
export function BrowserSocialStandingImage({request,image}:{request:StandingBrowserRequest;image:{assetId:string;version:number;sha256:string;altText:string}}):JSX.Element{
 const [preview,setPreview]=useState<z.infer<typeof previewSchema>|null>(null),[error,setError]=useState('');const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
 useEffect(()=>{if(!preview)return;const timer=setTimeout(()=>setPreview(null),Math.max(0,Date.parse(preview.expiresAt)-Date.now()));return ()=>clearTimeout(timer);},[preview]);
 const load=async()=>{setPreview(null);setError('');try{const answer=previewSchema.parse(await request('/social/media/preview',{assetId:image.assetId,version:image.version,sha256:image.sha256}));if(mounted.current)setPreview(answer);}catch{if(mounted.current)setError('Exact approved image unavailable; revalidate media before submission.');}};
 return <div><p>Approved image version {image.version}. Alt: {image.altText}</p><button onClick={()=>{void load();}}>Preview exact approved image</button>{preview?<img src={preview.url} alt={image.altText} referrerPolicy="no-referrer" style={{maxWidth:'100%',maxHeight:320}}/>:null}{error?<p role="status">{error}</p>:null}</div>;
}
