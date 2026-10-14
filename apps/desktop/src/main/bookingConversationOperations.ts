import type {AuthedClient} from './authedClient.ts';
import {OPERATIONS,type OperationInput} from '../shared/operations.ts';
export interface BookingConversationOperationDeps {api:AuthedClient;identity:{current():unknown}}
/** Every awaited authenticated answer is private to its original session generation. */
export function bookingConversationOperations(deps:BookingConversationOperationDeps){
 async function guarded<T>(call:()=>Promise<{ok:true;value:T}|{ok:false;reason:string}>):Promise<T>{
  const generation=deps.identity.current();const answer=await call();
  if(generation!==deps.identity.current())throw Error('session_changed');
  if(!answer.ok)throw Error(answer.reason);return answer.value;
 }
 return {
  'meetings.bookingConversationRequest':(input:OperationInput<'meetings.bookingConversationRequest'>)=>guarded(()=>deps.api.command('/meetings/booking-conversation',input,value=>OPERATIONS['meetings.bookingConversationRequest'].output.parse(value))),
  'meetings.bookingConversationRead':(input:OperationInput<'meetings.bookingConversationRead'>)=>guarded(()=>deps.api.read(`/meetings/booking-conversation?conversationId=${encodeURIComponent(input.conversationId)}`,value=>OPERATIONS['meetings.bookingConversationRead'].output.parse(value))),
  'meetings.bookingConversationEvent':(input:OperationInput<'meetings.bookingConversationEvent'>)=>guarded(()=>deps.api.command('/meetings/booking-conversation/event',input,value=>OPERATIONS['meetings.bookingConversationEvent'].output.parse(value))),
  'meetings.bookingMessageRequest':(input:OperationInput<'meetings.bookingMessageRequest'>)=>guarded(()=>deps.api.command('/meetings/booking-messages',input,value=>OPERATIONS['meetings.bookingMessageRequest'].output.parse(value))),
  'meetings.bookingMessageRead':(input:OperationInput<'meetings.bookingMessageRead'>)=>guarded(()=>deps.api.read(`/meetings/booking-messages?messageId=${encodeURIComponent(input.messageId)}`,value=>OPERATIONS['meetings.bookingMessageRead'].output.parse(value))),
 };
}
