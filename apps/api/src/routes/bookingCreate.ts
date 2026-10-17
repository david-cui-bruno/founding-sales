import {bookingCreateCommandSchema,bookingCreateInspectCommandSchema,uuid} from '@fss/contracts';
import {requestBookingCreate,readBookingCreate,requestBookingInspection} from '@fss/domain/meetings/bookingCreate.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const BOOKING_CREATE_PATHS:readonly string[]=['/meetings/booking-create','/meetings/booking-create/inspect'];
class BookingCreateSessionLost extends Error {}
export async function routeBookingCreate(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!BOOKING_CREATE_PATHS.includes(request.path))return null;
 if(options.auth===undefined)return {status:404,body:{error:'not_found'}};
 if(request.method!=='POST'&&(request.path!=='/meetings/booking-create'||request.method!=='GET'))return {status:405,body:{error:'method_not_allowed'}};
 const authenticated=await requirePrincipal(options.auth,request);if(!authenticated.ok)return authenticated.result;
 const authorize=async()=>{
  const current=await requirePrincipal(options.auth!,request);
  return current.ok&&current.principal.workspaceId===authenticated.principal.workspaceId&&current.principal.userId===authenticated.principal.userId&&current.principal.sessionId===authenticated.principal.sessionId&&current.principal.deviceId===authenticated.principal.deviceId&&current.principal.role===authenticated.principal.role;
 };
 if(request.method==='POST'){
  try{
   const response=request.path==='/meetings/booking-create/inspect'
    ?await runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingCreateInspectCommandSchema,'inspect_booking_create',async(context,body)=>{const result=await requestBookingInspection(context,body.submissionId);if(!await authorize())throw new BookingCreateSessionLost();return result;})
    :await runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingCreateCommandSchema,'request_booking_create',async(context,body)=>{const result=await requestBookingCreate(context,body,options.bookingCreate);if(!await authorize())throw new BookingCreateSessionLost();return result;});
   return await authorize()?response:{status:401,body:{error:'unauthenticated'}};
  }catch(error){if(error instanceof BookingCreateSessionLost)return {status:401,body:{error:'unauthenticated'}};throw error;}
 }
 const scoped=contextForPrincipal(options.auth,authenticated.principal);if(!scoped.ok)return scoped.result;
 const id=uuid.safeParse(request.query.get('submissionId'));if(!id.success)return {status:400,body:{error:'malformed_body'}};
 const receipt=await readBookingCreate(scoped.context,id.data);if(!await authorize())return {status:401,body:{error:'unauthenticated'}};return receipt===null?{status:404,body:{error:'not_found'}}:{status:200,body:receipt};
}
