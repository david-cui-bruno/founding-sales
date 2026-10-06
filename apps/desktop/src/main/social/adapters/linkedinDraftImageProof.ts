/** Read-only proof of one draft blob, not proof of saved native media identity.
 * Caller independently verifies account, exact composer URL and session.
 */
export function linkedInDraftImageProofScript():string{
 return `(async()=>{
 const fail=()=>({ok:false});
 const visible=e=>{for(let p=e;p;p=p.parentElement){const s=window.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 function snapshot(){
  const roots=[...document.querySelectorAll('dialog[open][data-testid="dialog"]')].filter(visible);if(roots.length!==1)return null;const root=roots[0];
  if(root.querySelectorAll('[componentkey="ShareBox_textEditor"]').length!==1||root.querySelector('[role="progressbar"],progress'))return null;
  const images=[...root.querySelectorAll('img')].filter(visible).filter(e=>{try{const u=new URL(e.src);return !(u.protocol==='https:'&&u.hostname==='media.licdn.com'&&!u.username&&!u.password&&!u.port&&/^\\/dms\\/image\\/v2\\/[A-Za-z0-9_-]+\\/profile-displayphoto-scale_100_100\\//.test(u.pathname));}catch{return true;}});
  if(images.length!==1)return null;const image=images[0],src=image.getAttribute('src')??'',alt=image.getAttribute('alt')??'';
  if(!/^blob:https:\\/\\/www\\.linkedin\\.com\\/[a-f0-9-]{36}$/.test(src)||alt.length>1000)return null;
  return {root,image,src,alt};
 }
 try{
  const before=snapshot();if(!before)return fail();
  const response=await fetch(before.src,{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok||!response.body)return fail();
  const reader=response.body.getReader(),parts=[];let bytes=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>5*1024*1024){await reader.cancel();return fail();}parts.push(chunk.value);}}finally{reader.releaseLock();}
  if(!bytes)return fail();const data=new Uint8Array(bytes);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.byteLength;}
  const digest=await crypto.subtle.digest('SHA-256',data);
  const after=snapshot();if(!after||after.root!==before.root||after.image!==before.image||after.src!==before.src||after.alt!==before.alt)return fail();
  return {ok:true,view:{sha256:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join(''),altText:after.alt,bytes}};
 }catch{return fail();}
})()`;
}
