import {linkedInDomScript} from './linkedinDom.ts';
/** Read-only saved edit-view evidence. Preview alt may be empty even after upload;
 * never substitute the approved alt or call this a complete media match.
 */
export function linkedInSavedDetailScript():string{
 return `(()=>{
 const composer=${linkedInDomScript({action:'read'})};
 if(!composer.ok||composer.view.kind!=='composer'||!composer.view.postingName||!composer.view.scheduleLabel)return {ok:false};
 const root=document.querySelector('dialog[open][data-testid="dialog"]');
 const back=Array.from(root.querySelectorAll('button')).filter(e=>e.textContent.trim()==='Back');if(back.length!==1)return {ok:false};
 const images=[];
 for(const image of Array.from(root.querySelectorAll('img'))){
  let url;try{url=new URL(image.getAttribute('src')??'');}catch{return {ok:false};}
  if(url.protocol!=='https:'||url.hostname!=='media.licdn.com'||url.username||url.password||url.port)return {ok:false};
  if(/^\\/dms\\/image\\/v2\\/[A-Za-z0-9_-]+\\/profile-displayphoto-scale_100_100\\//.test(url.pathname))continue;
  const match=url.pathname.match(/^\\/dms\\/image\\/v2\\/([A-Za-z0-9_-]{1,200})\\/(?:feedshare-image-high-res|feedshare-shrink_1280)\\//);if(!match)return {ok:false};
  const alt=image.getAttribute('alt')??'';if(alt.length>1000)return {ok:false};images.push({platformId:match[1],previewAlt:alt,loaded:image.complete&&image.naturalWidth>0});
 }
 if(images.length>20||new Set(images.map(i=>i.platformId)).size!==images.length)return {ok:false};
 return {ok:true,view:{postingName:composer.view.postingName,text:composer.view.text,scheduleLabel:composer.view.scheduleLabel,zone:composer.view.zone,images,altTextVerified:false}};
 })()`;
}
