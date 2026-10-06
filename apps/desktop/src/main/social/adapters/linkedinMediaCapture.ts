import {z} from 'zod';
import {linkedInDraftImageProofScript} from './linkedinDraftImageProof.ts';
const schema=z.strictObject({action:z.enum(['arm','read']),token:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),altText:z.string().max(1000)});
/** Read-only provenance capture. A native URL must appear on the SAME verified
 * draft image node while attached to its original composer. A later saved-list
 * lookup cannot establish this mapping. Native transition still needs acceptance.
 */
export function linkedInMediaCaptureScript(raw:z.infer<typeof schema>):string{
 const input=schema.parse(raw);
 return `(async()=>{const input=${JSON.stringify(input)},key='__callieLinkedInMediaCapture';const fail=()=>({ok:false});
 if(input.action==='read'){
  const s=window[key];if(!s||s.token!==input.token||s.sha256!==input.sha256||s.altText!==input.altText||s.invalid||!s.platformId)return fail();
  return {ok:true,view:{sha256:s.sha256,platformId:s.platformId}};
 }
 if(window[key])return fail();
 const roots=[...document.querySelectorAll('dialog[open][data-testid="dialog"]')];if(roots.length!==1)return fail();const root=roots[0];
 const candidates=[...root.querySelectorAll('img')].filter(i=>i.getAttribute('src')?.startsWith('blob:'));if(candidates.length!==1)return fail();const image=candidates[0],src=image.getAttribute('src');
 const proof=await ${linkedInDraftImageProofScript()};
 if(window[key]||!proof.ok||proof.view.sha256!==input.sha256||proof.view.altText!==input.altText||!root.isConnected||!root.contains(image)||image.getAttribute('src')!==src||image.alt!==input.altText)return fail();
 const state={token:input.token,sha256:input.sha256,altText:input.altText,platformId:null,invalid:false,observer:null,timer:null};
 const stop=()=>{state.observer?.disconnect();if(state.timer)window.clearTimeout(state.timer);};
 const invalidate=()=>{state.invalid=true;stop();};
 const observe=()=>{
  if(!root.isConnected||!root.contains(image)||image.alt!==input.altText){invalidate();return;}
  const next=image.getAttribute('src');if(next===src)return;
  let url;try{url=new URL(next);}catch{invalidate();return;}
  const match=url.pathname.match(/^\\/dms\\/image\\/v2\\/([A-Za-z0-9_-]{1,200})\\/(?:feedshare-image-high-res|feedshare-shrink_1280)\\//);
  if(url.protocol!=='https:'||url.hostname!=='media.licdn.com'||url.username||url.password||url.port||!match){invalidate();return;}
  state.platformId=match[1];stop();
 };
 state.observer=new MutationObserver(observe);state.observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','alt']});
 state.timer=window.setTimeout(invalidate,30000);window[key]=state;return {ok:true};
 })()`;
}
