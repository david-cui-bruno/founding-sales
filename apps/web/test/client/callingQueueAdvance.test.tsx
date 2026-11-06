// @vitest-environment jsdom
import {priorityFixturePage} from './support/priorityFixture.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,waitFor} from '@testing-library/react';
import {manualProspectSchema,type CallingSubject} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingQueue,type CallingQueueEntry} from '../../src/client/CallingQueue.tsx';
const id='10000000-0000-4000-8000-000000000001',first='20000000-0000-4000-8000-000000000001',second='20000000-0000-4000-8000-000000000002',clients:BrowserClient[]=[];
const prospect=(candidateId:string,revision:number)=>manualProspectSchema.parse({candidateId,revision,observedName:`Synthetic queue record ${candidateId.slice(-1)}`,website:null,locality:'Dallas',region:'TX',observedPhone:null,phoneBasis:'unknown',sources:[{label:'Synthetic retained source',url:null,observedAt:null}],sourceNotices:[],retainedAt:'2026-10-20T00:00:00.000Z',state:'kept',unknowns:['Unverified identity'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
const subject=(candidateId:string,expectedCandidateRevision:number):CallingSubject=>({kind:'candidate',candidateId,expectedCandidateRevision});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());});
async function mounted(rows:ReturnType<typeof prospect>[],selected:CallingSubject){
 const fetcher:typeof fetch=async url=>String(url)==='/browser/session'?Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()}):Response.json(priorityFixturePage({prospects:rows,hasMore:false}));
 const client=new BrowserClient({fetch:fetcher,storage:sessionStorage,manualActivityStorage:localStorage,navigate:vi.fn(),randomUUID:()=>id});clients.push(client);await client.refresh();
 const onSelect=vi.fn<(entry:CallingQueueEntry)=>void>(),ready=vi.fn<(advance:(()=>void)|null)=>void>();
 render(<CallingQueue client={client} onSelect={onSelect} onAdvanceReady={ready} selected={selected} disabled={false}/>);
 await waitFor(()=>expect(ready.mock.calls.at(-1)?.[0]).toBeTypeOf('function'));
 return {onSelect,advance:()=>ready.mock.calls.at(-1)![0]!()};
}
it('Next from the open revision moves to the next distinct record of the visible list',async()=>{
 const f=await mounted([prospect(first,2),prospect(second,1)],subject(first,2));
 f.advance();expect(f.onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({subject:subject(second,1)}));
});
it('a record opened at revision 1 that is now listed at revision 2 is selected itself, never skipped for another candidate',async()=>{
 const f=await mounted([prospect(first,2),prospect(second,1)],subject(first,1));
 f.advance();expect(f.onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({subject:subject(first,2)}));
});
it('a revised record that is the only visible one still offers Next and selects its current revision',async()=>{
 const f=await mounted([prospect(first,2)],subject(first,1));
 f.advance();expect(f.onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({subject:subject(first,2)}));
});
it('a selected record absent from the visible list opens the first visible record',async()=>{
 const f=await mounted([prospect(second,1)],subject(first,1));
 f.advance();expect(f.onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({subject:subject(second,1)}));
});
