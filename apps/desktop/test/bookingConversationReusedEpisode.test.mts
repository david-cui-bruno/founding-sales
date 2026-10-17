import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {createElement} from 'react';
import {bookingConversationViewSchema,bookingInterpretationViewSchema,bookingPolicyViewSchema} from '@fss/contracts';
import {bookingStopsFixture} from '../../api/test/support/bookingStopsFixture.ts';
import {BookingConversation,type BookingConversationPorts} from '../src/renderer/firms/BookingConversation.tsx';

afterEach(cleanup);
it('mounted current reinterpretation reads the original canonical episode and preserves shared counters and reply stops',async()=>{
 const f=await bookingStopsFixture();try{
  const event=async(event:string)=>{const response=await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event}));expect(response.status).toBe(200);};
  await event('manual_nudge');await event('reply');
  const second=await f.interpret();expect(second).not.toBe(f.firstInterpretation);
  const observed=await f.request('POST','/crm/booking/interpretation/read',{requestId:second});expect(observed.status).toBe(200);
  const interpretation=bookingInterpretationViewSchema.parse(observed.body);
  expect(await f.admit(second)).toBe(f.conversationId);
  const canonical=await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`);expect(canonical.status).toBe(200);
  const episode=bookingConversationViewSchema.parse(canonical.body);
  expect(episode.interpretationRequestId).toBe(f.firstInterpretation);expect(episode.nudgeCount).toBe(1);expect(episode.nudgesStoppedAt).not.toBeNull();
  const policyResponse=await f.request('GET','/meetings/booking-policy');expect(policyResponse.status).toBe(200);
  const policy=bookingPolicyViewSchema.parse(policyResponse.body);
  const read=vi.fn(async(input:{conversationId:string})=>{const response=await f.request('GET',`/meetings/booking-conversation?conversationId=${input.conversationId}`);expect(response.status).toBe(200);return bookingConversationViewSchema.parse(response.body);});
  const request=vi.fn(async(input:Parameters<BookingConversationPorts['request']>[0])=>{const response=await f.request('POST','/meetings/booking-conversation',f.command(input));expect(response.status).toBe(200);const body=response.body as {result:unknown};return bookingConversationViewSchema.parse(body.result);});
  const ports:BookingConversationPorts={policy:async()=>({revision:policy.revision,status:policy.setting.status}),request,read,event:async input=>{const response=await f.request('POST','/meetings/booking-conversation/event',f.command(input));expect(response.status).toBe(200);return bookingConversationViewSchema.parse((response.body as {result:unknown}).result);},messageRequest:async()=>{throw Error('not requested');},messageRead:async()=>{throw Error('not requested');}};
  render(createElement(BookingConversation,{ports,interpretation,privacyKey:f.fixture.alpha.admin.userId,sourceVersion:f.source.sourceRevision,enabled:true}));
  fireEvent.click(screen.getByRole('button',{name:'Manage booking conversation'}));
  expect(await screen.findByText('Booking-only nudges: 1 of 2. Manual nudges count toward this total.')).toBeTruthy();
  expect(request).toHaveBeenCalledWith({interpretationRequestId:second,expectedPolicyRevision:policy.revision});
  const admitted=await request.mock.results[0]!.value;
  expect(admitted.conversationId).toBe(f.conversationId);expect(admitted.interpretationRequestId).toBe(f.firstInterpretation);expect(admitted.nudgesStoppedAt).not.toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Inspect current booking conversation'}));
  expect(await screen.findByText(`Nudges stopped at ${admitted.nudgesStoppedAt}.`)).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();expect(request).toHaveBeenCalledTimes(1);
  expect((await f.fixture.db.query('SELECT id FROM booking_conversations WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(1);
 }finally{cleanup();await f.stop();}
});
