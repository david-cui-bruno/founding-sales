/** Structural DOM types keep the shared main-process import graph free of DOM globals. */
interface ProbeElement {
 parentElement:ProbeElement|null;textContent:string|null;
 getAttribute(name:string):string|null;hasAttribute(name:string):boolean;
 querySelector(selector:string):ProbeElement|null;querySelectorAll(selector:string):ArrayLike<ProbeElement>;
}
interface ProbeDocument {
 querySelectorAll(selector:string):ArrayLike<ProbeElement>;
 defaultView:{getComputedStyle(element:ProbeElement):{display:string;visibility:string}}|null;
}
export interface ObservedSocialIdentity {
 platform:'linkedin';externalAccountId:string;displayName:string;accountKind:'profile';
}
/** DOM-only probe, based on the own-profile sidebar observed 6 Oct 2026.
 * No cookies, private application state, feed authors, or guessed account IDs.
 * A changed/ambiguous layout is unsupported rather than an identity guess.
 */
export function readLinkedInIdentity(doc:ProbeDocument,pageUrl:string):ObservedSocialIdentity|null {
 function linkedInUrl(value:string):URL|null{
  try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.linkedin.com'&&!u.username&&!u.password&&!u.port?u:null;}catch{return null;}
 }
 function visible(el:ProbeElement):boolean{
  for(let p:ProbeElement|null=el;p;p=p.parentElement){
   if(p.hasAttribute('hidden')||p.getAttribute('aria-hidden')==='true')return false;
   const style=doc.defaultView?.getComputedStyle(p);if(style?.display==='none'||style?.visibility==='hidden')return false;
  }return true;
 }
 const page=linkedInUrl(pageUrl);if(!page||page.pathname!=='/feed/')return null;
 const sidebars=Array.from(doc.querySelectorAll('aside[aria-label="Sidebar"]')).filter(visible);
 if(sidebars.length!==1)return null;
 const profiles=new Map<string,{names:Set<string>;images:Set<string>}>();
 for(const a of Array.from(sidebars[0]!.querySelectorAll('a[href]'))){
  if(!visible(a))continue;
  const href=linkedInUrl(a.getAttribute('href')??'');
  if(!href||!/^\/in\/[a-zA-Z0-9_-]+\/$/.test(href.pathname)||href.search||href.hash)continue;
  const entry=profiles.get(href.href)??{names:new Set<string>(),images:new Set<string>()};profiles.set(href.href,entry);
  const label=a.querySelector('div[aria-label]');
  const name=label?.querySelector('p')?.textContent?.trim();
  // Text and portrait are separate links to the same own-profile URL.
  if(name&&label?.getAttribute('aria-label')?.startsWith(`${name},`))entry.names.add(name);
  for(const img of Array.from(a.querySelectorAll('img[alt]'))){const alt=img.getAttribute('alt')?.trim();if(alt&&visible(img))entry.images.add(alt);}
 }
 if(profiles.size!==1)return null;
 const [externalAccountId,e]=Array.from(profiles.entries())[0]!;
 if(e.names.size!==1||e.images.size!==1)return null;
 const displayName=Array.from(e.names)[0]!;
 if(!e.images.has(displayName)||displayName.length>200||Array.from(displayName).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))return null;
 return {platform:'linkedin',externalAccountId,displayName,accountKind:'profile'};
}
