import {z} from 'zod';
import {bookingMessageCommandSchema} from '../../../../packages/contracts/src/bookingMessages.ts';
import {requestBookingMessage,readBookingMessage} from '@fss/domain/meetings/bookingMessages.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const BOOKING_MESSAGES_PATH='/meetings/booking-messages';
class BookingMessageSessionLost extends Error {}
export async function routeBookingMessages(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(request.path!==BOOKING_MESSAGES_PATH)return null;
 if(!options.auth)return {status:404,body:{error:'not_found'}};
 if(!['POST','GET'].includes(request.method))return {status:405,body:{error:'method_not_allowed'}};
 const authenticated=await requirePrincipal(options.auth,request);if(!authenticated.ok)return authenticated.result;
 const authorize=async()=>{const current=await requirePrincipal(options.auth!,request);return current.ok&&current.principal.workspaceId===authenticated.principal.workspaceId&&current.principal.userId===authenticated.principal.userId&&current.principal.sessionId===authenticated.principal.sessionId&&current.principal.deviceId===authenticated.principal.deviceId&&current.principal.role===authenticated.principal.role;};
 if(request.method==='POST'){
  try{
   const response=await runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingMessageCommandSchema,'request_booking_message',async(ctx,body)=>{const result=await requestBookingMessage(ctx,body,options.bookingMessages);if(!await authorize())throw new BookingMessageSessionLost();return result;});
   return await authorize()?response:{status:401,body:{error:'unauthenticated'}};
  }catch(error){if(error instanceof BookingMessageSessionLost)return {status:401,body:{error:'unauthenticated'}};throw error;}
 }
 const scoped=contextForPrincipal(options.auth,authenticated.principal);if(!scoped.ok)return scoped.result;
 const id=z.uuid().safeParse(request.query.get('messageId'));if(!id.success)return {status:400,body:{error:'malformed_body'}};
 const receipt=await readBookingMessage(scoped.context,id.data);
 if(!await authorize())return {status:401,body:{error:'unauthenticated'}};
 return receipt?{status:200,body:receipt}:{status:404,body:{error:'not_found'}};
}
