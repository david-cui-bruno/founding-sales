import {bookingChangeCommandSchema,bookingChangeInspectCommandSchema,uuid} from '@fss/contracts';
import {requestBookingChange,readBookingChange,requestBookingChangeInspection} from '@fss/domain/meetings/bookingChange.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const BOOKING_CHANGE_PATHS:readonly string[]=['/meetings/booking-change','/meetings/booking-change/inspect'];
export async function routeBookingChange(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!BOOKING_CHANGE_PATHS.includes(request.path))return null;
 if(options.auth===undefined)return {status:404,body:{error:'not_found'}};
 if(request.method!=='POST'&&(request.path!=='/meetings/booking-change'||request.method!=='GET'))return {status:405,body:{error:'method_not_allowed'}};
 const authenticated=await requirePrincipal(options.auth,request);if(!authenticated.ok)return authenticated.result;
 if(request.method==='POST'){
  if(request.path==='/meetings/booking-change/inspect')return runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingChangeInspectCommandSchema,'inspect_booking_change',(context,body)=>requestBookingChangeInspection(context,body.submissionId));
  return runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingChangeCommandSchema,'request_booking_change',(context,body)=>requestBookingChange(context,body,options.bookingChange));
 }
 const scoped=contextForPrincipal(options.auth,authenticated.principal);if(!scoped.ok)return scoped.result;
 const id=uuid.safeParse(request.query.get('submissionId'));if(!id.success)return {status:400,body:{error:'malformed_body'}};
 const receipt=await readBookingChange(scoped.context,id.data);return receipt===null?{status:404,body:{error:'not_found'}}:{status:200,body:receipt};
}
