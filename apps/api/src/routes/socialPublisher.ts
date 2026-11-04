import {socialPublisherConnectionInputSchema,socialPublisherConnectionResultSchema} from '@fss/contracts';
import type {SocialBrowserPublisher} from '@fss/social-publisher';
import {PublisherRefusal} from '@fss/social-publisher';
import {contextForPrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {RouteResult} from './types.ts';

export const SOCIAL_PUBLISHER_CONNECTION_PATH='/social/publisher/connection';
/** Ephemeral credential transport: NEVER runCommand, receipts, audit, request logs or caches.
 * Connection ownership is derived solely from the retained authenticated principal. */
export async function routeSocialPublisherConnection(deps:RouteDeps,publisher:Pick<SocialBrowserPublisher,'connection'>|undefined):Promise<RouteResult>{
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
  const allowed=['connection_ready_to_verify','connection_capacity','connection_busy','connection_rate_limited','connection_expired','connection_unavailable','session_unavailable','account_mismatch','self_account_unverified','native_scheduling_unavailable','native_inspection_unavailable','publisher_account_mismatch','publisher_account_already_connected'];
  const reason=error instanceof PublisherRefusal&&allowed.includes(error.reason)?error.reason:'connection_unavailable';
  return {status:reason==='connection_rate_limited'?429:409,body:{error:reason}};
 }
}
