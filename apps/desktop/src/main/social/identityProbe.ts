import {readLinkedInIdentityDetailed,type ObservedSocialIdentity,type LinkedInIdentityProbe} from './identity.ts';
interface IdentityContents {
 getURL():string;
 executeJavaScriptInIsolatedWorld(worldId:number,scripts:{code:string}[],userGesture?:boolean):Promise<unknown>;
}
export async function probeLinkedInIdentity(contents:IdentityContents,isCurrent:()=>boolean):Promise<ObservedSocialIdentity|null>{
 const result=await probeLinkedInIdentityDetailed(contents,isCurrent);return 'reason' in result?null:result;
}
/** Main-process only. Call inside the runtime's bounded, account-scoped operation. */
export async function probeLinkedInIdentityDetailed(contents:IdentityContents,isCurrent:()=>boolean):Promise<LinkedInIdentityProbe>{
 const allowed=()=>{try{const u=new URL(contents.getURL());return u.origin==='https://www.linkedin.com'&&!u.username&&!u.password&&['/feed/','/sharing/compose'].includes(u.pathname);}catch{return false;}};
 try{
  if(!isCurrent())return {reason:'session_changed'};if(!allowed())return {reason:'identity_page_unavailable'};
  const value=await contents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${readLinkedInIdentityDetailed.toString()})(document, location.href)`}],false);
  if(!isCurrent())return {reason:'session_changed'};if(!allowed())return {reason:'identity_page_unavailable'};if(!value||typeof value!=='object')return {reason:'identity_unavailable'};
  const v=value as Record<string,unknown>;
  for(const reason of ['identity_page_unavailable','identity_sidebar_unavailable','identity_sidebar_ambiguous','identity_profile_unavailable','identity_profile_ambiguous','identity_evidence_unavailable'] as const){if(v['reason']===reason)return {reason};}
  if(v['platform']!=='linkedin'||v['accountKind']!=='profile'||typeof v['displayName']!=='string'||!v['displayName'].trim()||v['displayName'].length>200||Array.from(v['displayName']).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)||typeof v['externalAccountId']!=='string'||!/^https:\/\/www\.linkedin\.com\/in\/[a-zA-Z0-9_-]+\/$/.test(v['externalAccountId']))return {reason:'identity_probe_unavailable'};
  return {platform:'linkedin',accountKind:'profile',externalAccountId:v['externalAccountId'],displayName:v['displayName']};
 }catch{return {reason:isCurrent()?'identity_probe_unavailable':'session_changed'};}
}
