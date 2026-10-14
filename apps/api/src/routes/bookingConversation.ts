import {bookingConversationCommandSchema,bookingConversationEventCommandSchema,uuid} from '@fss/contracts';
import {requestBookingConversation,readBookingConversation,recordBookingConversationEvent} from '@fss/domain/meetings/bookingConversation.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const BOOKING_CONVERSATION_PATHS:readonly string[]=['/meetings/booking-conversation','/meetings/booking-conversation/event'];
export async function routeBookingConversation(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!BOOKING_CONVERSATION_PATHS.includes(request.path))return null;
 if(options.auth===undefined)return {status:401,body:{error:'unauthenticated'}};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 const authorize=async()=>{const current=await requirePrincipal(options.auth!,request);return current.ok&&current.principal.workspaceId===verified.principal.workspaceId&&current.principal.userId===verified.principal.userId&&current.principal.sessionId===verified.principal.sessionId&&current.principal.deviceId===verified.principal.deviceId&&current.principal.role===verified.principal.role;};
 if(request.method==='POST'){
  const receipt=request.path.endsWith('/event')?await runRouteCommand({auth:options.auth,request,principal:verified.principal},bookingConversationEventCommandSchema,'booking_conversation_event',(context,input)=>recordBookingConversationEvent(context,input,options.bookingConversation)):await runRouteCommand({auth:options.auth,request,principal:verified.principal},bookingConversationCommandSchema,'request_booking_conversation',(context,input)=>requestBookingConversation(context,input,options.bookingConversation));
  if(receipt.status!==200)return receipt;
  const envelope=receipt.body as {status:unknown;replayed:unknown;result?:{conversationId?:unknown}};
  const id=uuid.safeParse(envelope.result?.conversationId);if(!id.success)return receipt;
  const result=await withTransaction(options.auth.db,()=>readBookingConversation(scoped.context,id.data,options.bookingConversation,authorize));
  return result===null?{status:404,body:{error:'not_found'}}:{status:200,body:{status:envelope.status,replayed:envelope.replayed,result}};
 }
 if(request.method!=='GET'||request.path.endsWith('/event'))return {status:405,body:{error:'method_not_allowed'}};
 const id=uuid.safeParse(request.query.get('conversationId'));if(!id.success)return {status:400,body:{error:'malformed_body'}};
 const result=await withTransaction(options.auth.db,()=>readBookingConversation(scoped.context,id.data,options.bookingConversation,authorize));
 return result===null?{status:404,body:{error:'not_found'}}:{status:200,body:result};
}
