import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
import type {BookingPolicyRuntime} from '@fss/domain/meetings/bookingPolicyTypes.ts';
import {bookingPolicyCommandSchema} from '@fss/contracts';
import {mutateBookingPolicy,readBookingPolicyResponseObservation,bookingPolicyResponseObservationCurrentAt} from '@fss/domain/meetings/bookingPolicy.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import {settingLockName} from '@fss/domain/settings/store.ts';
export const BOOKING_POLICY_PATHS:readonly string[]=['/meetings/booking-policy'];
export async function routeBookingPolicy(request:ApiRequest,options:RoutingOptions&{bookingPolicyRuntime?:BookingPolicyRuntime}):Promise<RouteResult|null> {
  if(!BOOKING_POLICY_PATHS.includes(request.path))return null;
  const auth=options.auth;if(!auth)return {status:404,body:{error:'not_found'}};
  if(!['GET','POST'].includes(request.method))return {status:405,body:{error:'method_not_allowed'}};
  const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;
  const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
  if(scoped.context.scope.actor.kind!=='user'||scoped.context.scope.actor.role!=='admin')return {status:403,body:{error:'admin_required'}};
  if(request.method==='GET'){
    const view=request.query.get('view');
    if(view!==null&&view!=='settings')return {status:400,body:{error:'invalid_input'}};
    try{
      const observed=await readBookingPolicyResponseObservation(scoped.context,view,options.bookingPolicyRuntime);
      const current=await requirePrincipal(auth,request);
      if(!current.ok)return current.result;
      const before=principal.principal,after=current.principal;
      if(after.role!=='admin'||after.membershipStatus!=='active'||after.deviceStatus!=='active'||after.workspaceId!==before.workspaceId||after.userId!==before.userId||after.deviceId!==before.deviceId||after.sessionId!==before.sessionId)return {status:403,body:{error:'owner_authority_changed'}};
      const now=options.bookingPolicyRuntime?.now()??new Date().toISOString();
      if(!bookingPolicyResponseObservationCurrentAt(observed,now))return {status:409,body:{error:'booking_policy_observation_stale',message:'Current booking readiness and allowance are unknown. Refresh booking policy.'}};
      return {status:200,body:observed.body};
    }
    catch{return {status:403,body:{error:'owner_authority_changed'}};}
  }
  return runRouteCommand({auth,request,principal:principal.principal},bookingPolicyCommandSchema,'booking_policy',async(ctx,input)=>{
    // Authenticate the exact caller after the policy serialization wait, inside
    // the command transaction. Active membership alone does not preserve a
    // signed-out session or a revoked device's mutation authority.
    await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settingLockName(ctx.scope.workspaceId,'booking_policy')]);
    const current=await requirePrincipal(auth,request);
    if(!current.ok)return {ok:false,reason:'owner_authority_changed'};
    const before=principal.principal,after=current.principal;
    if(after.role!=='admin'||after.membershipStatus!=='active'||after.deviceStatus!=='active'||after.workspaceId!==before.workspaceId||after.userId!==before.userId||after.deviceId!==before.deviceId||after.sessionId!==before.sessionId)return {ok:false,reason:'owner_authority_changed'};
    return mutateBookingPolicy(ctx,input);
  });
}
