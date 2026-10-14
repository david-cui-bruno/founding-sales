// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it} from 'vitest';
import {bookingConversationInputSchema,bookingConversationViewSchema,bookingMessageCommandSchema,bookingMessageViewSchema,type BookingInterpretationView} from '@fss/contracts';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';
import {BookingConversation} from '../src/renderer/firms/BookingConversation.tsx';
const ID='11111111-1111-4111-8111-111111111111';
const conversation={conversationId:ID,interpretationRequestId:ID,policyRevision:3,origin:'standing_policy',enabled:false,state:'awaiting_time',reason:'live_held',outcome:{kind:'approved_link',bookingUrl:'https://cal.com/david/demo',permission:false,schedulingPaused:false},handoff:null,booking:null,change:null,nudgeCount:1,nudgesStoppedAt:null,lastReplyAt:null,explicitNoShowAt:null,noShowRebookingUsed:false,limitations:[]};
const message={messageId:ID,conversationId:ID,kind:'approved_link',state:'unknown_terminal',reason:'unknown_acceptance',outboundMessageId:null,providerMessageId:null,sentAt:null,limitations:[]};
const interpretation:BookingInterpretationView={requestId:ID,state:'complete',reason:null,outcome:{kind:'approved_link',bookingUrl:'https://cal.com/david/demo',permission:false,schedulingPaused:false},provenance:null,financial:null,limitations:[]};
afterEach(cleanup);
it('keeps compatible extended conversation and message answers readable through closed host operations and the mounted view',async()=>{
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url,init)=>{
  const response={...(new URL(url).pathname==='/meetings/booking-messages'?message:conversation),futureReceiptMetadata:{version:2}};
  return {status:200,body:init.method==='POST'?{status:'accepted',replayed:false,result:response}:response};
 }});
 const handlers=operationHandlers({api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);
 render(<BookingConversation interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled ports={{
  policy:async()=>({revision:3,status:'saved'}),
  request:async input=>bookingConversationViewSchema.parse(await answerOperation(handlers,'command','meetings.bookingConversationRequest',input)),
  read:async input=>bookingConversationViewSchema.parse(await answerOperation(handlers,'read','meetings.bookingConversationRead',input)),
  event:async input=>bookingConversationViewSchema.parse(await answerOperation(handlers,'command','meetings.bookingConversationEvent',input)),
  messageRequest:async input=>bookingMessageViewSchema.parse(await answerOperation(handlers,'command','meetings.bookingMessageRequest',input)),
  messageRead:async input=>bookingMessageViewSchema.parse(await answerOperation(handlers,'read','meetings.bookingMessageRead',input)),
 }}/>);
 const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Manage booking conversation'}));
 expect(await screen.findByText('Booking-only nudges: 1 of 2. Manual nudges count toward this total.')).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'Request approved booking link'}));
 expect(await screen.findByText('Booking message: unknown terminal')).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'Inspect current booking message'}));
 expect(await screen.findByText('Booking message: unknown terminal')).toBeTruthy();
 expect(screen.queryByRole('alert')).toBeNull();
});
it('keeps conversation and message caller authority inputs strict',()=>{
 expect(bookingConversationInputSchema.safeParse({interpretationRequestId:ID,expectedPolicyRevision:3,permission:true}).success).toBe(false);
 expect(bookingMessageCommandSchema.safeParse({commandId:ID,clientVersion:'1.0.49',conversationId:ID,kind:'approved_link',permission:true}).success).toBe(false);
});
