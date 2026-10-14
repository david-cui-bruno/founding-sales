import {bookingChangeCommandSchema,bookingChangeInspectCommandSchema,uuid} from '@fss/contracts';
import {requestBookingChange,readBookingChange,requestBookingChangeInspection} from '@fss/domain/meetings/bookingChange.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const BOOKING_CHANGE_PATHS:readonly string[]=['/meetings/booking-change','/meetings/booking-change/inspect'];
class BookingChangeSessionLost extends Error {}
export async function routeBookingChange(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!BOOKING_CHANGE_PATHS.includes(request.path))return null;
 if(options.auth===undefined)return {status:404,body:{error:'not_found'}};
 if(request.method!=='POST'&&(request.path!=='/meetings/booking-change'||request.method!=='GET'))return {status:405,body:{error:'method_not_allowed'}};
 const authenticated=await requirePrincipal(options.auth,request);if(!authenticated.ok)return authenticated.result;
 const authorize=async()=>{
  const current=await requirePrincipal(options.auth!,request);
  return current.ok&&current.principal.workspaceId===authenticated.principal.workspaceId&&current.principal.userId===authenticated.principal.userId&&current.principal.sessionId===authenticated.principal.sessionId&&current.principal.deviceId===authenticated.principal.deviceId&&current.principal.role===authenticated.principal.role;
 };
 if(request.method==='POST'){
  try{
   const response=request.path==='/meetings/booking-change/inspect'
    ?await runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingChangeInspectCommandSchema,'inspect_booking_change',async(context,body)=>{const result=await requestBookingChangeInspection(context,body.submissionId);if(!await authorize())throw new BookingChangeSessionLost();return result;})
    :await runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingChangeCommandSchema,'request_booking_change',async(context,body)=>{const result=await requestBookingChange(context,body,options.bookingChange);if(!await authorize())throw new BookingChangeSessionLost();return result;});
   return await authorize()?response:{status:401,body:{error:'unauthenticated'}};
  }catch(error){if(error instanceof BookingChangeSessionLost)return {status:401,body:{error:'unauthenticated'}};throw error;}
 }
 const scoped=contextForPrincipal(options.auth,authenticated.principal);if(!scoped.ok)return scoped.result;
 const id=uuid.safeParse(request.query.get('submissionId'));if(!id.success)return {status:400,body:{error:'malformed_body'}};
 const receipt=await readBookingChange(scoped.context,id.data);if(!await authorize())return {status:401,body:{error:'unauthenticated'}};return receipt===null?{status:404,body:{error:'not_found'}}:{status:200,body:receipt};
}
