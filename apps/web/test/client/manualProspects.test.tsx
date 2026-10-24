// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserManualProspects} from '../../src/client/BrowserManualProspects.tsx';
import {MANUAL_PROSPECT_PENDING_KEY} from '../../src/client/ManualProspectPending.ts';
const id='10000000-0000-4000-8000-000000000001';
const prospect={candidateId:id,revision:1,observedName:'<img src=x onerror=alert(1)> Loose fit',website:'javascript:alert(1)',locality:null,region:null,observedPhone:null,phoneBasis:'unknown',sources:[{label:'Retained source',url:'https://source.example.test/',observedAt:null}],sourceNotices:[{label:'CDLA-Permissive-2.0',url:null}],retainedAt:'2026-10-20T00:00:00.000Z',state:'new',unknowns:['Phone unknown'],possibleDuplicateCount:2,qualification:'unverified',contactAuthority:'not_granted'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(yes=>{resolve=yes;});return {resolve,promise};}
function setup(){
 const data=new Map<string,string>(),storage={getItem:vi.fn((key:string)=>data.get(key)??null),setItem:vi.fn((key:string,value:string)=>{data.set(key,value);}),removeItem:vi.fn((key:string)=>{data.delete(key);})};
 let session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'manual-session',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()};
 let lose=false,malformed=false,delayed:ReturnType<typeof deferred>|null=null,sessionDelay:ReturnType<typeof deferred>|null=null;
 const commands:unknown[]=[],reads:unknown[]=[];let state='new';
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  if(url==='/browser/session')return sessionDelay?await sessionDelay.promise:json(session);
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  if(String(url).endsWith('/prospects/list')){reads.push(body);return delayed?await delayed.promise:json({prospects:[{...prospect,state}],hasMore:reads.length===1});}
  expect(url).toBe('/browser/api/sourcing/candidates/prospects/feedback');expect(storage.getItem(MANUAL_PROSPECT_PENDING_KEY)).not.toBeNull();commands.push(body);state=String(body['state']);
  if(lose)throw Error('Lost response');return json(malformed?{}:{status:'accepted',replayed:commands.length>1,result:{candidateId:id,revision:1,state}});
 });
 const uuid=vi.fn(()=>crypto.randomUUID()),makeClient=()=>new BrowserClient({storage,fetch,randomUUID:uuid,navigate:vi.fn()}),client=makeClient();
 return {client,makeClient,storage,commands,reads,uuid,lose:(value=true)=>{lose=value;},malformed:()=>{malformed=true;},change:(patch:Partial<typeof session>)=>{session={...session,...patch};},delay:()=>{delayed=deferred();return delayed;},delaySession:()=>{sessionDelay=deferred();return {...sessionDelay,session};}};
}
async function ready(){await screen.findByRole('heading',{name:prospect.observedName});await waitFor(()=>{expect(screen.getByRole('button',{name:'Keep'}).hasAttribute('disabled')).toBe(false);});}
afterEach(cleanup);
it('initially reads bounded raw worklist, escapes text and unsafe links with no persistent projections or qualification requests',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();
 expect(s.reads).toEqual([{state:'all',offset:0}]);expect(s.commands).toEqual([]);expect(s.storage.setItem).not.toHaveBeenCalled();expect(s.uuid).not.toHaveBeenCalled();
 expect(screen.queryByRole('img')).toBeNull();expect(screen.getAllByRole('link')).toHaveLength(1);expect(screen.getByRole('link').getAttribute('rel')).toBe('noopener noreferrer');expect(screen.getAllByText(/Phone unknown/u).length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole('button',{name:'Next prospect page'}));await waitFor(()=>{expect(s.reads).toHaveLength(2);});expect(s.reads[1]).toEqual({state:'all',offset:50});
 await act(async()=>{s.client.dispose();});
});
it.each(['lost','malformed'])('retains %s feedback through reload and explicitly reconciles same UUID without automatic replay',async failure=>{
 const s=setup();await s.client.refresh();const component=render(<BrowserManualProspects client={s.client}/>);await ready();if(failure==='lost')s.lose();else s.malformed();
 fireEvent.click(screen.getByRole('button',{name:'Wrong number'}));await screen.findByRole('button',{name:'Reconcile same manual feedback'});expect(s.commands).toHaveLength(1);
 const bytes=s.storage.getItem(MANUAL_PROSPECT_PENDING_KEY);expect(bytes).not.toMatch(/Loose fit|https|source|csrf|Phone unknown/u);component.unmount();
 const next=s.makeClient();await next.refresh();render(<BrowserManualProspects client={next}/>);await screen.findByRole('button',{name:'Reconcile same manual feedback'});expect(s.commands).toHaveLength(1);
 if(failure==='lost'){s.lose(false);fireEvent.click(screen.getByRole('button',{name:'Reconcile same manual feedback'}));await waitFor(()=>{expect(next.manualProspects.read()?.receipt?.status).toBe('accepted');});expect(s.commands[1]).toEqual(s.commands[0]);}
 expect(s.uuid).toHaveBeenCalledTimes(1);await act(async()=>{next.dispose();s.client.dispose();});
});
it('storage failure refuses dispatch and does not silently replace custody',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();s.storage.setItem.mockImplementation(()=>{throw Error('Unavailable');});
 fireEvent.click(screen.getByRole('button',{name:'Keep'}));await screen.findByText(/Feedback outcome unknown/u);expect(s.commands).toEqual([]);expect(s.uuid).toHaveBeenCalledTimes(1);await act(async()=>{s.client.dispose();});
});
it('pre-dispatch session wait invalidation clears custody and blocks commands',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();const delay=s.delaySession();fireEvent.click(screen.getByRole('button',{name:'Keep'}));
 await waitFor(()=>{expect(s.client.manualProspects.read()).not.toBeNull();});await act(async()=>{delay.resolve(json({...delay.session,revision:'replaced'}));});
 expect(s.commands).toEqual([]);expect(s.storage.getItem(MANUAL_PROSPECT_PENDING_KEY)).toBeNull();expect(screen.queryByRole('heading',{name:prospect.observedName})).toBeNull();
});
it('late list response cannot restore observations after auth/session invalidation',async()=>{
 const s=setup();await s.client.refresh();const delayed=s.delay();render(<BrowserManualProspects client={s.client}/>);await waitFor(()=>{expect(s.reads).toHaveLength(1);});
 await act(async()=>{s.client.invalidate();delayed.resolve(json({prospects:[prospect],hasMore:false}));});expect(screen.queryByRole('heading',{name:prospect.observedName})).toBeNull();
});
it.each(['role','revision','expiry','auth'] as const)('clears IDs-only custody on %s authority change',async kind=>{
 const s=setup();await s.client.refresh();s.client.manualProspects.prepare({candidateId:id,expectedRevision:1,state:'skipped'});
 if(kind==='expiry'){const now=vi.spyOn(Date,'now').mockReturnValue(Date.now()+120001);s.client.isCurrent(s.client.epoch);now.mockRestore();}
 else if(kind==='auth')s.client.invalidate();else{s.change(kind==='role'?{role:'sales'}:{revision:'new'});await expect(s.client.refresh()).rejects.toThrow();}
 expect(s.storage.getItem(MANUAL_PROSPECT_PENDING_KEY)).toBeNull();s.client.dispose();
});
