import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readLinkedinRecurringPosting} from '@fss/domain/social/linkedinRecurringPosting.ts';
import {contextForPrincipal,requirePrincipal} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const LINKEDIN_RECURRING_PATHS=['/social/linkedin-recurring/read'];
export async function routeLinkedinRecurring(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!LINKEDIN_RECURRING_PATHS.includes(request.path))return null;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const auth=options.auth;if(!auth)return {status:401,body:{error:'unauthenticated'}};
 const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;
 const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
 if(!z.strictObject({}).safeParse(request.body).success)return {status:400,body:{error:'invalid_input'}};
 const body=await withTransaction(auth.db,()=>readLinkedinRecurringPosting(scoped.context,options.linkedinRecurring));
 // The owner/policy read can wait. Reauthenticate outside the completed read
 // transaction so sign-out or device revocation cannot publish private history.
 const current=await requirePrincipal(auth,request);if(!current.ok)return current.result;
 const before=principal.principal,after=current.principal;
 if(after.workspaceId!==before.workspaceId||after.userId!==before.userId
 ||after.sessionId!==before.sessionId||after.deviceId!==before.deviceId
 ||after.role!==before.role||after.membershipStatus!==before.membershipStatus
 ||after.deviceStatus!==before.deviceStatus||after.clientVersion!==before.clientVersion)
 return {status:401,body:{error:'unauthenticated'}};
 return {status:200,body};
}
