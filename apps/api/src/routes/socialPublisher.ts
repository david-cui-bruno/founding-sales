import {socialPublisherConnectionInputSchema,socialPublisherConnectionResultSchema} from '@fss/contracts';
import type {SocialBufferPublisher} from '@fss/social-publisher';
import {PublisherRefusal} from '@fss/social-publisher';
import {contextForPrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {RouteResult} from './types.ts';

export const SOCIAL_PUBLISHER_CONNECTION_PATH='/social/publisher/connection';
/** Ephemeral credential transport: NEVER runCommand, receipts, audit, request logs or caches.
 * Connection ownership is derived solely from the retained authenticated principal. */
export async function routeSocialPublisherConnection(deps:RouteDeps,publisher:Pick<SocialBufferPublisher,'connection'>|undefined):Promise<RouteResult>{
 if(deps.request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const input=socialPublisherConnectionInputSchema.safeParse(deps.request.body);
 if(!input.success)return {status:400,body:{error:'invalid_input'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const actor=scoped.context.scope.actor;
 if(actor.kind!=='user'||actor.role!=='admin')return {status:403,body:{error:'admin_required'}};
 if(!publisher)return {status:503,body:{error:'publisher_unavailable'}};
 let changed=false;
 const retained=retainedPrincipalAuthority(deps,scoped.context);
 const authority=async()=>{
  const member=await scoped.context.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[scoped.context.scope.workspaceId,actor.userId]);
  if(member.rowCount!==1||!await retained()){changed=true;throw new Error('publisher_authority_changed');}
 };
 try{
  return await withTransaction(scoped.context.db,async()=>{
   await authority();
   const result=await publisher.connection({workspaceId:scoped.context.scope.workspaceId,ownerUserId:actor.userId,sessionId:deps.principal.sessionId,deviceId:deps.principal.deviceId},input.data,authority);
   await authority();return {status:200,body:socialPublisherConnectionResultSchema.parse(result)};
  });
 }catch(error){
  if(changed)return {status:401,body:{error:'unauthenticated'}};
  try{await authority();}catch{return {status:401,body:{error:'unauthenticated'}};}
  const allowed=['credential_invalid','credential_revoked','credential_unavailable','provider_rate_limited','discovery_limit','channel_unavailable','channel_permission_denied','queue_paused','account_mismatch','publisher_account_mismatch','publisher_account_already_connected','publisher_account_limit','runtime_closed'];
  const reason=error instanceof PublisherRefusal&&allowed.includes(error.reason)?error.reason:'connection_unavailable';
  // Vendor errors never invalidate app authentication; 409 has that meaning in BrowserClient.
  return {status:reason==='provider_rate_limited'?429:503,body:{error:reason}};
 }
}
