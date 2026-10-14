import {z} from 'zod';
import {bookingMessageCommandSchema} from '../../../../packages/contracts/src/bookingMessages.ts';
import {requestBookingMessage,readBookingMessage} from '@fss/domain/meetings/bookingMessages.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const BOOKING_MESSAGES_PATH='/meetings/booking-messages';
export async function routeBookingMessages(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(request.path!==BOOKING_MESSAGES_PATH)return null;
 if(!options.auth)return {status:404,body:{error:'not_found'}};
 if(!['POST','GET'].includes(request.method))return {status:405,body:{error:'method_not_allowed'}};
 const authenticated=await requirePrincipal(options.auth,request);if(!authenticated.ok)return authenticated.result;
 if(request.method==='POST')return runRouteCommand({auth:options.auth,request,principal:authenticated.principal},bookingMessageCommandSchema,'request_booking_message',(ctx,body)=>requestBookingMessage(ctx,body,options.bookingMessages));
 const scoped=contextForPrincipal(options.auth,authenticated.principal);if(!scoped.ok)return scoped.result;
 const id=z.uuid().safeParse(request.query.get('messageId'));if(!id.success)return {status:400,body:{error:'malformed_body'}};
 const receipt=await readBookingMessage(scoped.context,id.data);
 return receipt?{status:200,body:receipt}:{status:404,body:{error:'not_found'}};
}
