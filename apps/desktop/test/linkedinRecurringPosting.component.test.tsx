/** @vitest-environment jsdom */
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,act} from '@testing-library/react';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import type {LinkedinRecurringView} from '@fss/contracts';
import {LinkedinRecurringPosting} from '../src/renderer/social/LinkedinRecurringPosting.tsx';
import {linkedinRecurringPostingOperations} from '../src/main/social/linkedinRecurringPostingOperations.ts';
import {createAuthedClient} from '../src/main/authedClient.ts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
const queued:LinkedinRecurringView={holds:[],items:[{id,targetAt:'2026-11-03T15:00:00.000Z',accountId:id,accountRevision:1,policyRevision:2,state:'queued',reason:null,approvalKind:'standing_policy',postId:id,draftRequestId:id,receiptId:null,submissionId:null,spendCents:1}]};
it('owner refresh reads current source/revoke state and retained unknown marker without manual approval or Enable',async()=>{
 let view=queued;const read=vi.fn(async()=>({view,reason:null}));render(<LinkedinRecurringPosting ports={{read}}/>);
 await screen.findByText(/Queued for existing desktop scheduling/);expect(screen.getByText(/policy revision 2/i)).toBeTruthy();expect(screen.getByText(/\$0.01/)).toBeTruthy();expect(screen.queryByRole('button',{name:/approve|enable/i})).toBeNull();
 view={holds:[],items:[{...queued.items[0]!,state:'review',reason:'source_changed_or_unavailable'}]};fireEvent.click(screen.getByRole('button',{name:'Refresh recurring posting'}));await screen.findByText(/source changed or unavailable/);
 view={holds:[],items:[{...queued.items[0]!,state:'revoked'}]};fireEvent.click(screen.getByRole('button',{name:'Refresh recurring posting'}));await screen.findByText(/Revoked: no further eligible dispatch/);
 view={holds:[],items:[{...queued.items[0]!,state:'unknown_paused',submissionId:id}]};fireEvent.click(screen.getByRole('button',{name:'Refresh recurring posting'}));await screen.findByText(/Inspect original submission, never replay/);expect(screen.getByText(/Submission marker/)).toBeTruthy();
});
it('failed read removes stale queue eligibility rather than presenting old state as current',async()=>{
 let failed=false;render(<LinkedinRecurringPosting ports={{read:async()=>failed?{view:null,reason:'offline'}:{view:queued,reason:null}}}/>);await screen.findByText(/Queued for existing desktop scheduling/);failed=true;fireEvent.click(screen.getByRole('button',{name:'Refresh recurring posting'}));await screen.findByText(/Current recurring state is unavailable/);expect(screen.queryByText(/Queued for existing desktop scheduling/)).toBeNull();
});
it('trusted read operation drops an answer across identity generation change',async()=>{
 let generation=1;const api=createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:'0.3.0',accessToken:async()=>({token:'controlled',generation}),send:async()=>{generation++;return {status:200,body:queued};}});const host=linkedinRecurringPostingOperations({api,generation:()=>generation});expect(await host['social.recurringPosting']()).toEqual({view:null,reason:'session_changed'});
});
it('a replaced owner session never displays a delayed previous-owner queue',async()=>{
 let resolve!:(value:{view:LinkedinRecurringView|null;reason:string|null})=>void;
 const prior=new Promise<{view:LinkedinRecurringView|null;reason:string|null}>(r=>{resolve=r;});
 const ui=render(<DraftsProvider key="prior"><LinkedinRecurringPosting ports={{read:()=>prior}}/></DraftsProvider>);
 ui.rerender(<DraftsProvider key="next"><LinkedinRecurringPosting ports={{read:async()=>({view:{holds:[],items:[]},reason:null})}}/></DraftsProvider>);
 await screen.findByText('No recurring preparation recorded.');await act(async()=>{resolve({view:queued,reason:null});await prior;});expect(screen.queryByText(/Queued for existing desktop scheduling/)).toBeNull();
});
