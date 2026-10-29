import {socialPublicThreadListInputSchema,socialPublicThreadReadInputSchema,type SocialPublicThreadList,type SocialPublicThreadView} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {listSocialPublicThreads,readSocialPublicThread,PublicThreadAuthorityChanged} from '@fss/domain/social/publicThreads.ts';
import {contextForPrincipal,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {samePrivatePrincipal} from './privateReadAuthority.ts';
import {retainedPrincipalPublicationAuthority} from './retainedPrincipalAuthority.ts';
import type {RouteResult} from './types.ts';
export const SOCIAL_PUBLIC_THREAD_PATHS=['/social/threads/list','/social/threads/read'] as const;
function expired(view:SocialPublicThreadView,now:number):SocialPublicThreadView{
 return view.availability==='available'&&Date.parse(view.expiresAt)<=now?{threadId:view.threadId,revision:view.revision,capturedAt:view.capturedAt,expiresAt:view.expiresAt,availability:'unavailable',reason:'expired'}:view;
}
function expiredList(view:SocialPublicThreadList,now:number):SocialPublicThreadList{
 return {...view,threads:view.threads.map(thread=>thread.availability==='available'&&Date.parse(thread.expiresAt)<=now
  ?{threadId:thread.threadId,revision:thread.revision,capturedAt:thread.capturedAt,expiresAt:thread.expiresAt,availability:'unavailable',reason:'expired'}:thread)};
}
/** Exact signed POST reads only. No capture, source fetch, erase or publishing route. */
export async function routeSocialPublicThreads(deps:RouteDeps):Promise<RouteResult>{
 if(deps.request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const list=deps.request.path===SOCIAL_PUBLIC_THREAD_PATHS[0];
 if(!list&&deps.request.path!==SOCIAL_PUBLIC_THREAD_PATHS[1])return {status:404,body:{error:'not_found'}};
 const parsed=(list?socialPublicThreadListInputSchema:socialPublicThreadReadInputSchema).safeParse(deps.request.body);
 if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const check=async()=>{const fresh=await requirePrincipal(deps.auth,deps.request);if(!fresh.ok||!samePrivatePrincipal(fresh.principal,deps.principal))throw new PublicThreadAuthorityChanged();};
 const authority=retainedPrincipalPublicationAuthority(deps,scoped.context);
 try{
  const answer=await withTransaction(deps.auth.db,async()=>{
   await check();
   const result='threadId' in parsed.data
    ?{kind:'read' as const,thread:await readSocialPublicThread(scoped.context,parsed.data,authority)}
    :{kind:'list' as const,view:await listSocialPublicThreads(scoped.context,parsed.data.afterId,authority)};
   // Keep the original row/principal locks through the final authentication wait.
   await check();return result;
  });
  // COMMIT may wait. No new auth/source await is permitted after releasing locks.
  const now=authority.publicationNow(deps.auth.now().getTime());if(now===null)throw new PublicThreadAuthorityChanged();
  if(answer.kind==='read')return answer.thread===null?{status:404,body:{error:'not_found'}}:{status:200,body:{thread:expired(answer.thread,now)}};
  return {status:200,body:expiredList(answer.view,now)};
 }catch(error){if(error instanceof PublicThreadAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};throw error;}
}
