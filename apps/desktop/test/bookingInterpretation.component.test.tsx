// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it} from 'vitest';
import {BookingInterpretation} from '../src/renderer/firms/BookingInterpretation.tsx';
const ID='11111111-1111-4111-8111-111111111111';
const source={sourceId:ID,sourceRevision:1,contentHash:'a'.repeat(64)};
afterEach(cleanup);
it('shows missing canonical consent and route visibly without treating a request as permission',async()=>{
 const view={requestId:ID,state:'unavailable' as const,reason:'booking_authority_unavailable',outcome:null,provenance:null,financial:null,limitations:['no_sending_or_booking' as const]};
 const requests:unknown[]=[];
 render(<BookingInterpretation ports={{request:async input=>{requests.push(input);return view;},read:async()=>view}} source={source} privacyKey="owner" sourceVersion={1} enabled/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Interpret booking request'}));
 expect(await screen.findByText('booking authority unavailable')).toBeTruthy();
 expect(requests).toEqual([{source,priorSources:[]}]);
 expect(screen.getByText('Proposals only. This cannot send a message or create an appointment.')).toBeTruthy();
 expect(screen.queryByRole('button',{name:/send|book appointment/i})).toBeNull();
});
