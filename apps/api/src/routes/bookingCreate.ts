import {bookingCreateCommandSchema,bookingCreateInspectCommandSchema,uuid} from '@fss/contracts';
import {requestBookingCreate,readBookingCreate,requestBookingInspection} from '@fss/domain/meetings/bookingCreate.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const BOOKING_CREATE_PATHS:readonly string[]=['/meetings/booking-create','/meetings/booking-create/inspect'];
export async function routeBookingCreate(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!BOOKING_CREATE_PATHS.includes(request.path))return null;
 if(options.auth===undefined)return {status:404,body:{error:'not_found'}};
 if(request.method!=='POST'&&(request.path!=='/meetings/booking-create'||request.method!=='GET'))return {status:405,body:{error:'method_not_allowed'}};
 const authenticated=await requirePrincipal(options.auth,request);if(!authenticated.ok)return authenticated.result;
 if(request.method==='POST'){
  if(request.path==='/meetings/booking-create/inspect')return runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingCreateInspectCommandSchema,'inspect_booking_create',(context,body)=>requestBookingInspection(context,body.submissionId));
  return runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingCreateCommandSchema,'request_booking_create',(context,body)=>requestBookingCreate(context,body,options.bookingCreate));
 }
 const scoped=contextForPrincipal(options.auth,authenticated.principal);if(!scoped.ok)return scoped.result;
 const id=uuid.safeParse(request.query.get('submissionId'));if(!id.success)return {status:400,body:{error:'malformed_body'}};
 const receipt=await readBookingCreate(scoped.context,id.data);return receipt===null?{status:404,body:{error:'not_found'}}:{status:200,body:receipt};
}
