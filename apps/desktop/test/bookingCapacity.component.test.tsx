// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import type {BookingCapacityResponse} from '@fss/contracts';
import {BookingCapacity} from '../src/renderer/meetings/BookingCapacity.tsx';
afterEach(cleanup);
const value=(extra:Partial<BookingCapacityResponse['provider']>={}):BookingCapacityResponse=>({
  preference:{weeklyIntroCalls:3,enforcementVerified:false},
  provider:{status:'unavailable',reason:'api_key_missing',observedAt:null,bookingUrl:'https://cal.com/callie-founder/intro',eventTypeId:null,weeklyLimit:null,scope:'event_type',...extra},
  recorded:{observedAt:'2026-10-08T12:00:00.000Z',windowStart:'2026-10-01T12:00:00.000Z',windowEnd:'2026-12-07T12:00:00.000Z',truncated:false,bookings:[]},
});
it('shows missing calendar access and the unverified three-call preference without claiming free slots',async()=>{
  render(<BookingCapacity ports={{async read(){return {capacity:value()};}}}/>);
  expect((await screen.findByTestId('booking-capacity-preference')).textContent).toContain('enforcement is not verified');
  expect(await screen.findByText(/Calendar access is missing/)).toBeTruthy();
  expect(screen.queryByText(/slots? (left|available)/i)).toBeNull();
});
it('shows a confirmed event-specific limit without promoting it to a global capacity guarantee',async()=>{
  render(<BookingCapacity ports={{async read(){return {capacity:value({status:'observed',reason:null,observedAt:'2026-10-08T12:00:00.000Z',eventTypeId:73,weeklyLimit:3})};}}}/>);
  expect(await screen.findByText(/limits this booking link to 3 bookings per week/)).toBeTruthy();
  expect(screen.getByTestId('booking-capacity-provider').textContent).toContain('Other event types');
  expect(screen.getByTestId('booking-capacity-preference').textContent).toContain('enforcement is not verified');
});
it('does not turn an observed event without a verified weekly limit into a capacity guarantee',async()=>{
  render(<BookingCapacity ports={{async read(){return {capacity:value({status:'observed',reason:null,observedAt:'2026-10-08T12:00:00.000Z',eventTypeId:73,weeklyLimit:null})};}}}/>);
  expect(await screen.findByText(/No weekly limit was verified for this booking link/)).toBeTruthy();
  expect(screen.getByTestId('booking-capacity-provider').textContent).not.toContain('limits this booking link');
});

it('keeps ambiguous attendees visible without inventing a firm and opens only an existing matched firm',async()=>{
  const known='11111111-1111-4111-8111-111111111111',opened:string[]=[];
  const capacity=value();capacity.recorded.bookings=[
    {meetingId:'22222222-2222-4222-8222-222222222222',state:'booked',startsAt:'2026-10-09T15:00:00.000Z',endsAt:'2026-10-09T15:30:00.000Z',sourceUpdatedAt:'2026-10-07T14:00:00.000Z',firm:{id:known,name:'Known Office'},attendeeEmail:'manager@known.example',matchReason:null},
    {meetingId:'33333333-3333-4333-8333-333333333333',state:'rescheduled',startsAt:'2026-10-10T15:00:00.000Z',endsAt:'2026-10-10T15:30:00.000Z',sourceUpdatedAt:'2026-10-08T14:00:00.000Z',firm:null,attendeeEmail:'manager@shared.example',matchReason:'firm_ambiguous'},
  ];
  render(<BookingCapacity ports={{async read(){return {capacity};}}} onOpenFirm={id=>opened.push(id)}/>);
  expect(await screen.findByText(/manager@shared.example/)).toBeTruthy();
  expect(screen.getByText(/More than one firm could match/)).toBeTruthy();
  expect(screen.getAllByTestId('booking-capacity-source')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'Open Known Office'}));expect(opened).toEqual([known]);
  expect(screen.queryByRole('button',{name:/Open manager@shared/})).toBeNull();
});
it('refresh failure clears stale configured capacity without claiming there are no appointments',async()=>{
  let reads=0;
  render(<BookingCapacity ports={{async read(){reads++;if(reads===1)return {capacity:value({status:'observed',reason:null,observedAt:'2026-10-08T12:00:00.000Z',eventTypeId:73,weeklyLimit:3})};throw new Error('offline');}}}/>);
  expect(await screen.findByText(/limits this booking link to 3/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Refresh booking evidence'}));
  expect(await screen.findByText(/could not read booking evidence/)).toBeTruthy();
  expect(screen.queryByText(/limits this booking link/)).toBeNull();
  expect(screen.queryByText(/No saved bookings/)).toBeNull();
});
it.each([
  {reason:'booking_link_missing',text:'Save your approved Cal.com booking link'},
  {reason:'provider_forbidden',text:'Cal.com did not allow this settings read'},
  {reason:'event_ambiguous',text:'More than one Cal.com event matched'},
] as const)('explains $reason as an actionable missing-evidence result',async({reason,text})=>{
  render(<BookingCapacity ports={{async read(){return {capacity:value({reason})};}}}/>);
  expect(await screen.findByText(new RegExp(text))).toBeTruthy();
});

it('does not apply an old pending settings read after the view changes to current access',async()=>{
  let resolve:(answer:{capacity:BookingCapacityResponse})=>void=()=>undefined;
  const old=new Promise<{capacity:BookingCapacityResponse}>(done=>{resolve=done;});
  const view=render(<BookingCapacity ports={{async read(){return await old;}}}/>);
  view.rerender(<BookingCapacity ports={{async read(){return {capacity:value({reason:'provider_forbidden'})};}}}/>);
  expect(await screen.findByText(/Cal.com did not allow this settings read/)).toBeTruthy();
  await act(async()=>{resolve({capacity:value({status:'observed',reason:null,observedAt:'2026-10-08T12:00:00.000Z',eventTypeId:73,weeklyLimit:3})});});
  expect(screen.getByTestId('booking-capacity-provider').textContent).toContain('did not allow this settings read');
  expect(screen.queryByText(/limits this booking link/)).toBeNull();
});
