import {socialPublishingReadinessInputSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readSocialPublishingReadiness} from '@fss/domain/social/publishingReadiness.ts';
import {PrivateDraftAuthorityChanged} from '@fss/domain/social/privateDrafts.ts';
import {contextForPrincipal,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {samePrivatePrincipal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';

export const SOCIAL_PUBLISHING_READINESS_PATH='/social/publishing/readiness';
export async function routeSocialPublishingReadiness(deps:RouteDeps):Promise<RouteResult>{
 if(deps.request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const parsed=socialPublishingReadinessInputSchema.safeParse(deps.request.body);
 if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const check=async()=>{
  const fresh=await requirePrincipal(deps.auth,deps.request);
  if(!fresh.ok||!samePrivatePrincipal(deps.principal,fresh.principal))throw new PrivateDraftAuthorityChanged();
 };
 try{
  await check();
  const result=await withTransaction(deps.auth.db,()=>readSocialPublishingReadiness(scoped.context,retainedPrincipalAuthority(deps,scoped.context)));
  await check();
  return result.ok?{status:200,body:result.value}:{status:403,body:{error:'publishing_readiness_unavailable'}};
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};throw error;}
}
