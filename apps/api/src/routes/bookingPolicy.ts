import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
import type {BookingPolicyRuntime} from '@fss/domain/meetings/bookingPolicyTypes.ts';
import {bookingPolicyCommandSchema} from '@fss/contracts';
import {mutateBookingPolicy,readBookingPolicy} from '@fss/domain/meetings/bookingPolicy.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
export const BOOKING_POLICY_PATHS:readonly string[]=['/meetings/booking-policy'];
export async function routeBookingPolicy(request:ApiRequest,options:RoutingOptions&{bookingPolicyRuntime?:BookingPolicyRuntime}):Promise<RouteResult|null> {
  if(!BOOKING_POLICY_PATHS.includes(request.path))return null;
  const auth=options.auth;if(!auth)return {status:404,body:{error:'not_found'}};
  if(!['GET','POST'].includes(request.method))return {status:405,body:{error:'method_not_allowed'}};
  const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;
  const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
  if(scoped.context.scope.actor.kind!=='user'||scoped.context.scope.actor.role!=='admin')return {status:403,body:{error:'admin_required'}};
  if(request.method==='GET')return {status:200,body:await readBookingPolicy(scoped.context,options.bookingPolicyRuntime)};
  return runRouteCommand({auth,request,principal:principal.principal},bookingPolicyCommandSchema,'booking_policy',mutateBookingPolicy);
}
