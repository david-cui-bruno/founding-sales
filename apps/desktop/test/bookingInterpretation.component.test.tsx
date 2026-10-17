// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it} from 'vitest';
import {BookingInterpretation,type BookingInterpretationPorts} from '../src/renderer/firms/BookingInterpretation.tsx';
const ID='11111111-1111-4111-8111-111111111111';
const source={sourceId:ID,sourceRevision:1,contentHash:'a'.repeat(64)};
afterEach(cleanup);
it('shows missing canonical consent and route visibly without treating a request as permission',async()=>{
 const view={requestId:ID,state:'unavailable' as const,reason:'booking_authority_unavailable',outcome:null,provenance:null,financial:null,limitations:['no_sending_or_booking' as const]};
 const requests:unknown[]=[];
 render(<BookingInterpretation ports={{request:async input=>{requests.push(input);return view;},read:async()=>view}} source={source} privacyKey="owner" sourceVersion={1} enabled/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Interpret booking request'}));
 expect(await screen.findByText('booking authority unavailable')).toBeTruthy();
 expect(requests).toEqual([{source,priorSources:[],commandId:expect.any(String)}]);
 expect(screen.getByText('Proposals only. This cannot send a message or create an appointment.')).toBeTruthy();
 expect(screen.queryByRole('button',{name:/send|book appointment/i})).toBeNull();
});
it('keeps the exact selected inputs and command identity across an unknown request response',async()=>{
 const view={requestId:ID,state:'pending' as const,reason:null,outcome:null,provenance:null,financial:null,limitations:['no_sending_or_booking' as const]};
 const requests:Parameters<BookingInterpretationPorts['request']>[0][]=[];
 const ports:BookingInterpretationPorts={request:async input=>{requests.push(input);if(requests.length===1)throw new Error('offline');return view;},read:async()=>view};
 render(<BookingInterpretation ports={ports} source={source} privacyKey="owner" sourceVersion={1} enabled priorChoices={[source]}/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Interpret booking request'}));
 expect((await screen.findByRole('alert')).textContent).toContain('unknown');
 expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true);
 await userEvent.setup().click(screen.getByRole('button',{name:'Retry booking request'}));
 expect(await screen.findByText('Interpretation state: pending')).toBeTruthy();
 expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);
 expect(screen.getByRole('button',{name:'Interpret booking request'}).hasAttribute('disabled')).toBe(true);
});
it('refreshes a known accepted request without creating another request when its current read fails',async()=>{
 const view={requestId:ID,state:'pending' as const,reason:null,outcome:null,provenance:null,financial:null,limitations:['no_sending_or_booking' as const]};
 let requests=0,reads=0;
 const ports:BookingInterpretationPorts={request:async()=>{requests++;return view;},read:async()=>{reads++;if(reads===1)throw new Error('offline');return view;}};
 render(<BookingInterpretation ports={ports} source={source} privacyKey="owner" sourceVersion={1} enabled/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Interpret booking request'}));
 expect(await screen.findByRole('alert')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Interpret booking request'}).hasAttribute('disabled')).toBe(true);
 await userEvent.setup().click(screen.getByRole('button',{name:'Refresh booking outcome'}));
 expect(await screen.findByText('Interpretation state: pending')).toBeTruthy();expect(requests).toBe(1);expect(reads).toBe(2);
});
it('forgets an old owner pending identity and ignores its late response when privacy changes',async()=>{
 const view={requestId:ID,state:'pending' as const,reason:null,outcome:null,provenance:null,financial:null,limitations:['no_sending_or_booking' as const]};
 let release!:(value:typeof view)=>void;const requests:Parameters<BookingInterpretationPorts['request']>[0][]=[];
 const ports:BookingInterpretationPorts={request:async input=>{requests.push(input);return new Promise<typeof view>(resolve=>{release=resolve;});},read:async()=>view};
 const mounted=render(<BookingInterpretation ports={ports} source={source} privacyKey="owner" sourceVersion={1} enabled/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Interpret booking request'}));
 mounted.rerender(<BookingInterpretation ports={ports} source={source} privacyKey="other-owner" sourceVersion={2} enabled/>);
 release(view);
 expect(screen.queryByText('Interpretation state: pending')).toBeNull();expect(screen.queryByRole('button',{name:'Refresh booking outcome'})).toBeNull();
 await userEvent.setup().click(screen.getByRole('button',{name:'Interpret booking request'}));
 expect(requests).toHaveLength(2);expect(requests[1]!.commandId).not.toBe(requests[0]!.commandId);
});
