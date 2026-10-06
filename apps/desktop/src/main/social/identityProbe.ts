import {readLinkedInIdentity,type ObservedSocialIdentity} from './identity.ts';
interface IdentityContents {
 getURL():string;
 executeJavaScriptInIsolatedWorld(worldId:number,scripts:{code:string}[],userGesture?:boolean):Promise<unknown>;
}
/** Main-process only. Call inside the runtime's bounded, account-scoped operation. */
export async function probeLinkedInIdentity(contents:IdentityContents,isCurrent:()=>boolean):Promise<ObservedSocialIdentity|null>{
 try{
  if(!isCurrent()||contents.getURL()!=='https://www.linkedin.com/feed/')return null;
  const value=await contents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${readLinkedInIdentity.toString()})(document, location.href)`}],false);
  if(!isCurrent()||contents.getURL()!=='https://www.linkedin.com/feed/'||!value||typeof value!=='object')return null;
  const v=value as Record<string,unknown>;
  if(v['platform']!=='linkedin'||v['accountKind']!=='profile'||typeof v['displayName']!=='string'||!v['displayName'].trim()||v['displayName'].length>200||Array.from(v['displayName']).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)||typeof v['externalAccountId']!=='string'||!/^https:\/\/www\.linkedin\.com\/in\/[a-zA-Z0-9_-]+\/$/.test(v['externalAccountId']))return null;
  return {platform:'linkedin',accountKind:'profile',externalAccountId:v['externalAccountId'],displayName:v['displayName']};
 }catch{return null;}
}
