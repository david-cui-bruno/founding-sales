// @vitest-environment jsdom
import {cleanup,render,screen,act} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {RecordProgress} from '../src/renderer/firms/RecordProgress.tsx';
import type {CrmProgressResponse} from '@fss/contracts';
const firmId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const page:CrmProgressResponse={version:1,events:[{id,kind:'contacted',occurredAt:'2026-09-25T14:00:00.000Z',dateBasis:'provider_event',observedAt:'2026-10-01T14:00:00.000Z',bookingState:null,firmIds:[firmId],personIds:[],source:null,evidence:{kind:'mail_source',id}}],truncated:false,coverage:'partial'};
afterEach(cleanup);
it('shows verified progress distinctly from an automatic stage change or attendance',async()=>{
 render(<RecordProgress enabled firmId={firmId} privacyKey="account-a" ports={{read:async()=>page}}/>);
 expect(await screen.findByText('Contacted')).toBeTruthy();expect(screen.queryByText('Attended')).toBeNull();expect(screen.queryByText('Stage changed')).toBeNull();
 expect(screen.getByText('Some conversations may not be available yet.')).toBeTruthy();
});
it('clears the previous record and ignores a late answer after the account changes',async()=>{
 let finish:(value:CrmProgressResponse)=>void=()=>{};const pending=new Promise<CrmProgressResponse>(resolve=>{finish=resolve;});
 const view=render(<RecordProgress enabled firmId={firmId} privacyKey="account-a" ports={{read:async()=>pending}}/>);
 view.rerender(<RecordProgress enabled firmId={firmId} privacyKey="account-b" ports={{read:async()=>({...page,events:[]})}}/>);
 await act(async()=>finish(page));expect(screen.queryByText('Contacted')).toBeNull();
});
