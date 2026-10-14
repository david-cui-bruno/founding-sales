import {bookingConversationCommandSchema,bookingConversationEventCommandSchema,uuid} from '@fss/contracts';
import {requestBookingConversation,readBookingConversation,recordBookingConversationEvent} from '@fss/domain/meetings/bookingConversation.ts';
import {bookingPolicySnapshotReadyAt} from '@fss/domain/meetings/bookingPolicy.ts';
import type {BookingPolicySnapshot} from '@fss/domain/meetings/bookingPolicyTypes.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';
export const BOOKING_CONVERSATION_PATHS:readonly string[]=['/meetings/booking-conversation','/meetings/booking-conversation/event'];
class BookingConversationSessionLost extends Error {}
export async function routeBookingConversation(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!BOOKING_CONVERSATION_PATHS.includes(request.path))return null;
 if(options.auth===undefined)return {status:401,body:{error:'unauthenticated'}};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 const authorize=async()=>{const current=await requirePrincipal(options.auth!,request);return current.ok&&current.principal.workspaceId===verified.principal.workspaceId&&current.principal.userId===verified.principal.userId&&current.principal.sessionId===verified.principal.sessionId&&current.principal.deviceId===verified.principal.deviceId&&current.principal.role===verified.principal.role;};
 const currentRead=async(id:string,envelope?:{status:unknown;replayed:unknown}):Promise<RouteResult>=>{
  let observed:BookingPolicySnapshot|undefined;
  const result=await withTransaction(options.auth!.db,()=>readBookingConversation(scoped.context,id,options.bookingConversation,authorize,snapshot=>{observed=snapshot;}));
  // Reuse the validated private observation after COMMIT, never a second provider read.
  if(!await authorize())return {status:401,body:{error:'unauthenticated'}};
  if(observed!==undefined&&options.bookingConversation!==undefined&&!bookingPolicySnapshotReadyAt(observed,options.bookingConversation.policy.now()))return {status:409,body:{error:'booking_readiness_unavailable'}};
  return result===null?{status:404,body:{error:'not_found'}}:{status:200,body:envelope===undefined?result:{status:envelope.status,replayed:envelope.replayed,result}};
 };
 if(request.method==='POST'){
  try{
   const receipt=request.path.endsWith('/event')
    ?await runRouteCommand({auth:options.auth,request,principal:verified.principal},bookingConversationEventCommandSchema,'booking_conversation_event',async(context,input)=>{const result=await recordBookingConversationEvent(context,input,options.bookingConversation);if(!await authorize())throw new BookingConversationSessionLost();return result;})
    :await runRouteCommand({auth:options.auth,request,principal:verified.principal},bookingConversationCommandSchema,'request_booking_conversation',async(context,input)=>{const result=await requestBookingConversation(context,input,options.bookingConversation);if(!await authorize())throw new BookingConversationSessionLost();return result;});
   if(!await authorize())return {status:401,body:{error:'unauthenticated'}};
   if(receipt.status!==200)return receipt;
   const envelope=receipt.body as {status:unknown;replayed:unknown;result?:{conversationId?:unknown}};
   const id=uuid.safeParse(envelope.result?.conversationId);if(!id.success)return receipt;
   return currentRead(id.data,envelope);
  }catch(error){if(error instanceof BookingConversationSessionLost)return {status:401,body:{error:'unauthenticated'}};throw error;}
 }
 if(request.method!=='GET'||request.path.endsWith('/event'))return {status:405,body:{error:'method_not_allowed'}};
 const id=uuid.safeParse(request.query.get('conversationId'));if(!id.success)return {status:400,body:{error:'malformed_body'}};
 return currentRead(id.data);
}
