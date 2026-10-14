// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {act} from '@testing-library/react';
import {BookingConversation,type BookingConversationPorts} from '../src/renderer/firms/BookingConversation.tsx';
import {BookingInterpretation} from '../src/renderer/firms/BookingInterpretation.tsx';
import type {BookingConversationView,BookingInterpretationView} from '@fss/contracts';
const ID='11111111-1111-4111-8111-111111111111';
const source={sourceId:ID,sourceRevision:1,contentHash:'a'.repeat(64)};
const interpretation:BookingInterpretationView={requestId:ID,state:'complete',reason:null,outcome:{kind:'approved_link',bookingUrl:'https://cal.com/david/demo',schedulingPaused:false,permission:false},provenance:null,financial:null,limitations:['candidate_not_permission']};
const conversation:BookingConversationView={conversationId:ID,interpretationRequestId:ID,policyRevision:3,origin:'standing_policy',enabled:false,state:'awaiting_time',reason:'live_held',outcome:interpretation.outcome,handoff:null,booking:null,change:null,nudgeCount:1,nudgesStoppedAt:null,lastReplyAt:null,explicitNoShowAt:null,noShowRebookingUsed:false,limitations:['actual_provider_acceptance_unverified']};
function ports(){return {policy:vi.fn(async()=>({revision:3,status:'saved' as const})),request:vi.fn(async()=>conversation),read:vi.fn(async()=>conversation),event:vi.fn(async()=>conversation),messageRequest:vi.fn(async()=>{throw Error('held');}),messageRead:vi.fn(async()=>{throw Error('held');})};}
it('does not admit without an observed saved current policy',async()=>{
 const base=ports();const conversationPorts:BookingConversationPorts={...base,policy:async()=>null};
 render(<BookingConversation ports={conversationPorts} interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Manage booking conversation'}));
 expect(await screen.findByRole('alert')).toBeTruthy();expect(base.request).not.toHaveBeenCalled();
});
for(const wait of ['policy','request','read'] as const)it(`source/privacy changes invalidate a pending ${wait} and never publish stale private state`,async()=>{
 const base=ports();let resolve:(value:unknown)=>void=()=>{};
 const pending=new Promise<unknown>(done=>{resolve=done;});
 const scopedPorts:BookingConversationPorts={...base,[wait]:()=>pending};
 const rendered=render(<BookingConversation ports={scopedPorts} interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Manage booking conversation'}));
 rendered.rerender(<BookingConversation ports={scopedPorts} interpretation={interpretation} privacyKey="new-session" sourceVersion={2} enabled/>);
 await act(async()=>{resolve(wait==='policy'?{revision:3,status:'saved'}:{...conversation,handoff:{ownerUserId:ID,action:'review_booking',evidence:{sourceId:ID,start:0,end:6,quote:'stale secret'}}});await pending;});
 expect(screen.queryByText('stale secret')).toBeNull();expect(screen.queryByText(/Conversation state/)).toBeNull();
 if(wait==='policy')expect(base.request).not.toHaveBeenCalled();if(wait==='request')expect(base.read).not.toHaveBeenCalled();
});
it('records manual activity against the same observed revision then reads shared stops and counters',async()=>{
 const base=ports();render(<BookingConversation ports={base} interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled/>);
 const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Manage booking conversation'}));
 base.read.mockResolvedValue({...conversation,nudgeCount:2,nudgesStoppedAt:'2026-10-14T00:00:00Z',state:'handoff'});
 await user.click(await screen.findByRole('button',{name:'Record manual booking nudge'}));
 expect(base.event).toHaveBeenCalledWith({conversationId:ID,expectedPolicyRevision:3,event:'manual_nudge'});
 expect(await screen.findByText('Booking-only nudges: 2 of 2. Manual nudges count toward this total.')).toBeTruthy();
 expect((screen.getByRole('button',{name:'Record manual booking nudge'}) as HTMLButtonElement).disabled).toBe(true);
});
it('reads a held message receipt and never retries unknown message acceptance',async()=>{
 const base=ports(),message={messageId:ID,conversationId:ID,kind:'approved_link' as const,state:'unknown_terminal' as const,reason:'inspect',outboundMessageId:null,providerMessageId:null,sentAt:null,limitations:[]};
 const messageRequest=vi.fn(async()=>message),messageRead=vi.fn(async()=>message);
 render(<BookingConversation ports={{...base,messageRequest,messageRead}} interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled/>);
 const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Manage booking conversation'}));await user.click(await screen.findByRole('button',{name:'Request approved booking link'}));
 expect(messageRequest).toHaveBeenCalledWith({conversationId:ID,kind:'approved_link'});
 expect(await screen.findByText('Booking message: unknown terminal')).toBeTruthy();expect(screen.queryByRole('button',{name:'Request approved booking link'})).toBeNull();
 await user.click(screen.getByRole('button',{name:'Inspect current booking message'}));expect(messageRequest).toHaveBeenCalledTimes(1);
});

it('renders accepted booking and replaced reminder receipts, requiring David to confirm no-show',async()=>{
 const base=ports();base.read.mockResolvedValue({...conversation,state:'rescheduled',booking:{submissionId:ID,state:'accepted',providerBookingUid:'booking-current',meetingId:ID,sourceState:'current',reason:null,dispatchStartedAt:null},change:{submissionId:ID,state:'accepted',action:'reschedule',targetBookingUid:'booking-old',providerBookingUid:'booking-current',meetingId:ID,sourceState:'current',reason:null,dispatchStartedAt:null,reminderState:'replaced'}});
 render(<BookingConversation ports={base} interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled/>);
 const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Manage booking conversation'}));
 expect(await screen.findByText('Reminder state: replaced')).toBeTruthy();expect(screen.getByRole('region',{name:'Booking receipt'})).toBeTruthy();
 expect(base.event).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'David: confirm no-show'}));
 expect(base.event).toHaveBeenCalledWith({conversationId:ID,expectedPolicyRevision:3,event:'confirm_no_show'});
});
it('does not offer to replay admission when request acceptance is unavailable',async()=>{
 const base=ports();base.request.mockRejectedValue(Error('unknown'));
 render(<BookingConversation ports={base} interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Manage booking conversation'}));
 expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByRole('button',{name:'Manage booking conversation'})).toBeNull();expect(base.request).toHaveBeenCalledTimes(1);
});
it('does not replay a message whose request acceptance is unavailable after conversation inspection',async()=>{
 const base=ports();render(<BookingConversation ports={base} interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled/>);
 const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Manage booking conversation'}));await user.click(await screen.findByRole('button',{name:'Request approved booking link'}));
 expect(await screen.findByRole('alert')).toBeTruthy();await user.click(screen.getByRole('button',{name:'Inspect current booking conversation'}));
 expect(screen.queryByRole('button',{name:'Request approved booking link'})).toBeNull();expect(base.messageRequest).toHaveBeenCalledTimes(1);
});

it('holds uncertain manual-event acceptance across a current inspection rather than replaying it',async()=>{
 const base=ports();base.event.mockRejectedValue(Error('unknown'));
 render(<BookingConversation ports={base} interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled/>);
 const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Manage booking conversation'}));await user.click(await screen.findByRole('button',{name:'Record manual booking nudge'}));
 expect(await screen.findByRole('alert')).toBeTruthy();await user.click(screen.getByRole('button',{name:'Inspect current booking conversation'}));
 expect(screen.queryByRole('button',{name:'Record manual booking nudge'})).toBeNull();expect(base.event).toHaveBeenCalledTimes(1);
});

afterEach(cleanup);
it('admits the current normal selected interpretation without human confirmation or typed identifiers',async()=>{
 const conversationPorts=ports();
 render(<BookingInterpretation ports={{request:async()=>interpretation,read:async()=>interpretation}} conversationPorts={conversationPorts} source={source} privacyKey="owner" sourceVersion={1} enabled/>);
 const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Interpret booking request'}));
 await user.click(await screen.findByRole('button',{name:'Manage booking conversation'}));
 expect(conversationPorts.request).toHaveBeenCalledWith({interpretationRequestId:ID,expectedPolicyRevision:3});
 expect(await screen.findByText('Booking-only nudges: 1 of 2. Manual nudges count toward this total.')).toBeTruthy();
 expect(screen.getByText(/Live booking automation held/)).toBeTruthy();
 expect(screen.queryByRole('textbox')).toBeNull();
});
it('unknown current acceptance exposes inspection only and clears private readback when unavailable',async()=>{
 const conversationPorts=ports();conversationPorts.read.mockResolvedValue({...conversation,state:'unknown',handoff:{ownerUserId:ID,action:'review_booking',evidence:{sourceId:ID,start:0,end:6,quote:'secret'}}});
 render(<BookingInterpretation ports={{request:async()=>interpretation,read:async()=>interpretation}} conversationPorts={conversationPorts} source={source} privacyKey="owner" sourceVersion={1} enabled/>);
 const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Interpret booking request'}));await user.click(await screen.findByRole('button',{name:'Manage booking conversation'}));
 expect(await screen.findByText('secret')).toBeTruthy();expect(screen.queryByRole('button',{name:'Record manual booking nudge'})).toBeNull();expect(screen.queryByRole('button',{name:'Request approved booking link'})).toBeNull();
 conversationPorts.read.mockRejectedValue(Error('unavailable'));await user.click(screen.getByRole('button',{name:'Inspect current booking conversation'}));
 expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('secret')).toBeNull();
});
