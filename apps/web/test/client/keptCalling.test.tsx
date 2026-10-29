// @vitest-environment jsdom
import {priorityFixturePage} from './support/priorityFixture.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {manualProspectSchema,type ManualPhoneChoice} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingContext} from '../../src/client/CallingContext.tsx';
import {CallingQueue} from '../../src/client/CallingQueue.tsx';
import {ManualPhoneNumber} from '../../src/client/ManualPhoneNumber.tsx';
import {projectProspectPhoneDiscovery} from '@fss/domain/sourcing/prospectPhoneDiscoveryProjection.ts';
import {phoneSupplyObservation,phoneSupplyRun} from '../../../../packages/domain/test/sourcing/phoneSupplyFixtures.ts';
const id='10000000-0000-4000-8000-000000000001',clients:BrowserClient[]=[];
function fixture(){
 const run=phoneSupplyRun([phoneSupplyObservation(['Office phone: 214-555-0123'])]);run.expires_at=new Date(Date.now()+60000);
 const evidence=projectProspectPhoneDiscovery(run,Date.now());if(evidence.state!=='observed')throw Error('Expected controlled phone');
 const source=evidence.sources[0]!;if(!('method'in source))throw Error('Expected literal');
 const choice:ManualPhoneChoice={runId:source.runId,observationId:source.observationId,blockId:source.blockId,labelStart:source.labelStart,labelEnd:source.labelEnd,start:source.start,end:source.end,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash};
 const p=manualProspectSchema.parse({candidateId:id,revision:1,observedName:'FICTIONAL Kept818 Company',website:null,locality:'Dallas',region:'TX',observedPhone:evidence.value,phoneBasis:'retained_observation',phoneEvidence:evidence,sources:[{label:'Fictional source',url:null,observedAt:null}],sourceNotices:[],retainedAt:new Date().toISOString(),state:'new',unknowns:['Unverified identity'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
 const phone={value:evidence.value,choice,sourceUrl:source.url,retrievedAt:source.retrievedAt,expiresAt:run.expires_at.toISOString()};return {p,choice,phone};
}
function client(fetcher:typeof fetch,role='admin'){
 const wrapped:typeof fetch=async(url,init)=>String(url)==='/browser/session'?Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role,revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()}):fetcher(url,init);
 const c=new BrowserClient({fetch:wrapped,storage:sessionStorage,manualActivityStorage:localStorage,navigate:vi.fn(),randomUUID:()=>id});clients.push(c);return c;
}
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());sessionStorage.clear();localStorage.clear();vi.useRealTimers();});
it.each([false,true])('saves and current-reads chosen source metadata, with same-UUID unknown recovery=%s',async unknown=>{
 const f=fixture(),writes:unknown[]=[],reads:unknown[]=[];let attempts=0;
 const c=client(async(url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(String(url).endsWith('/feedback')){writes.push(body);if(unknown&&++attempts===1)throw Error('Controlled unknown');return Response.json({status:'accepted',replayed:unknown,result:{candidateId:id,revision:1,state:'kept',phoneChoice:f.choice}});}
  if(String(url).endsWith('/prospects/priority/list')){reads.push(body);return Response.json(priorityFixturePage({prospects:[{...f.p,state:'kept',manualPhone:f.phone}],hasMore:false}));}
  if(String(url).endsWith('/prospects/list')){reads.push(body);return Response.json({prospects:[{...f.p,state:'kept',manualPhone:f.phone}],hasMore:false});}
  throw Error('No other route allowed');
 });await c.refresh();
 render(<CallingContext client={c} entry={{subject:{kind:'candidate',candidateId:id,expectedCandidateRevision:1},label:f.p.observedName,prospect:f.p}} onReady={()=>undefined}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Keep +12145550123 in Calling'}));
 if(unknown){await screen.findByRole('button',{name:'Reconcile manual selection'});fireEvent.click(screen.getByRole('button',{name:'Reconcile manual selection'}));}
 await screen.findByLabelText('Chosen manual number');
 expect(reads).toEqual([{state:'all',offset:0,candidateId:id,expectedRevision:1,includeManualPhone:true}]);
 expect(writes).toHaveLength(unknown?2:1);if(unknown)expect(writes[1]).toEqual(writes[0]);
 expect(JSON.stringify(writes)).not.toMatch(/214|Office phone|capacity\.example/u);expect(JSON.stringify({...sessionStorage,...localStorage})).not.toMatch(/214|Office phone|capacity\.example/u);
});
it('defaults admin to kept, resets paging for retained, and never requests retained for salesperson',async()=>{
 const reads:unknown[]=[],c=client(async(url,init)=>{if(!String(url).endsWith('/prospects/priority/list'))throw Error('Unexpected');reads.push(JSON.parse(String(init?.body)));return Response.json(priorityFixturePage({prospects:[],hasMore:true}));});await c.refresh();
 const view=render(<CallingQueue client={c} onSelect={()=>undefined} disabled={false}/>);
 await waitFor(()=>expect(reads).toHaveLength(1));fireEvent.click(screen.getByRole('button',{name:'Next page'}));await waitFor(()=>expect(reads).toHaveLength(2));fireEvent.click(screen.getByRole('button',{name:'Retained list'}));await waitFor(()=>expect(reads).toHaveLength(3));
 expect(reads).toEqual([{state:'kept',offset:0,includeManualPhone:true},{state:'kept',offset:50,includeManualPhone:true,viewRevision:'a'.repeat(64)},{state:'all',offset:0,includeManualPhone:true}]);view.unmount();
 const paths:string[]=[],sales=client(async url=>{paths.push(String(url));return Response.json({version:4,workspaceId:id,businessTimeZone:'America/New_York',asOf:new Date().toISOString(),actions:[],promiseCoverage:{scope:'current_authorized_work',truncated:false,nextAfterId:null}});},'salesperson');await sales.refresh();render(<CallingQueue client={sales} onSelect={()=>undefined} disabled={false}/>);
 await waitFor(()=>expect(paths).toHaveLength(1));expect(paths[0]).toMatch(/\/today\/actions\/v4$/u);expect(screen.getByRole('button',{name:'Kept prospects'}).matches(':disabled')).toBe(true);
});
it('drops expired chosen numbers and refuses unsafe source anchors',async()=>{
 vi.useFakeTimers();const f=fixture();f.phone.sourceUrl='javascript:alert(1)';render(<ManualPhoneNumber phone={f.phone}/>);expect(screen.queryByRole('link')).toBeNull();expect(screen.getByLabelText('Chosen manual number')).toBeTruthy();
 await act(async()=>{vi.advanceTimersByTime(60001);});expect(screen.queryByLabelText('Chosen manual number')).toBeNull();
});
