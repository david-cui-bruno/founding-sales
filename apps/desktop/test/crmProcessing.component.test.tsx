import userEvent from '@testing-library/user-event';
// @vitest-environment jsdom
import {cleanup,render,screen,act} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {ProcessingHealth} from '../src/renderer/firms/ProcessingHealth.tsx';
afterEach(cleanup);
const source={workspaceId:'11111111-1111-4111-8111-111111111111',sourceId:'22222222-2222-4222-8222-222222222222',kind:'selected_note' as const,revision:2,contentHash:null,locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-01T14:00:00Z',completeness:'unavailable' as const,availability:'deleted' as const};
it('keeps an unknown payment blocker visible on a record after source deletion',async()=>{
 render(<ProcessingHealth source={source} ports={{health:async()=>({sourceId:source.sourceId,sourceRevision:2,availability:'deleted',generations:[{generationId:'33333333-3333-4333-8333-333333333333',contextHash:'a'.repeat(64),authorizationHash:'b'.repeat(64),purposeRevision:1,sourceRevision:1,processorVersion:'crm-extract-v1',modelVersion:'fixture-v1',state:'deleted',reason:'source_deleted',claims:[],financial:{dispatchState:'unknown_acceptance',settlementState:'estimated',settledCents:4}}],truncated:false,unknownAcceptance:false}),request:async()=>{throw new Error('No retry permitted');}}}/>);
 expect(await screen.findByText('Provider acceptance is unknown. Another attempt is blocked.')).toBeTruthy();
 expect(screen.getByText('Estimated cost: 4¢')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Request extraction'})).toBeNull();
});
it('keeps a blocker outside the bounded history page visible and prevents another request',async()=>{
 render(<ProcessingHealth source={{...source,availability:'available',contentHash:'a'.repeat(64)}} ports={{health:async()=>({sourceId:source.sourceId,sourceRevision:2,availability:'available',generations:[],truncated:true,unknownAcceptance:true}),request:async()=>{throw new Error('No repeat');}}}/>);
 expect(await screen.findByText('Provider acceptance is unknown. Another attempt is blocked.')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Request extraction'})).toBeNull();
});

it('discards a failed extraction request after navigating to another source',async()=>{
 let reject!: (error:Error)=>void;const pending=new Promise<void>((_,failed)=>{reject=failed;});
 const ports={health:async(input:{sourceId:string})=>({sourceId:input.sourceId,sourceRevision:2,availability:'available' as const,generations:[],truncated:false,unknownAcceptance:false}),request:async()=>await pending};
 const first={...source,availability:'available' as const,contentHash:'a'.repeat(64)};const second={...first,sourceId:'44444444-4444-4444-8444-444444444444'};
 const view=render(<ProcessingHealth source={first} ports={ports}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Request extraction'}));
 view.rerender(<ProcessingHealth source={second} ports={ports}/>);
 await screen.findByRole('button',{name:'Request extraction'});
 await act(async()=>reject(new Error('Old request failed')));
 expect(screen.queryByRole('alert')).toBeNull();
});
