// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {callingSubjectSchema,manualProspectSchema} from '@fss/contracts';
import {BrowserApp} from '../../src/client/BrowserApp.tsx';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {callingSelectionSchema} from '../../src/client/workspaceNavigation.ts';
import {CallingWorkspace} from '../../src/client/CallingWorkspace.tsx';

const id='10000000-0000-4000-8000-000000000001';
function prospect(index:number){return manualProspectSchema.parse({candidateId:`20000000-0000-4000-8000-${String(index).padStart(12,'0')}`,revision:3,observedName:`Fictional observation ${index}`,website:null,locality:'Boston',region:'MA',observedPhone:null,phoneBasis:'unknown',sources:[{label:'Fictional retained source',url:'https://source.example.test/',observedAt:null}],sourceNotices:[],retainedAt:'2026-10-25T00:00:00.000Z',state:'kept',unknowns:['Identity unverified'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});}
const first=Array.from({length:50},(_,i)=>prospect(i+1)),selected=prospect(51);
const clients:BrowserClient[]=[];
const json=(value:unknown,status=200)=>Response.json(value,{status});
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(done=>{resolve=done;});return {promise,resolve};}
function setup(){
 const reads:Array<{state:string;offset:number}>=[];
 let fresh:()=>Promise<Response>=async()=>json({prospects:[{...selected,sources:[{label:'Fresh retained source',url:'https://fresh.example.test/',observedAt:null}]}],hasMore:true});
 let pageTwoReads=0;
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  const path=String(url);
  if(path==='/browser/session')return json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()});
  if(path.startsWith('/browser/api/today?'))return json({workspaceId:id,snapshotDate:'2026-10-27',businessTimeZone:'America/New_York',cards:[]});
  if(path.endsWith('/today/actions/v4'))return json({version:4,workspaceId:id,businessTimeZone:'America/New_York',asOf:'2026-10-27T00:00:00.000Z',actions:[],promiseCoverage:{scope:'current_authorized_work',truncated:false,nextAfterId:null}});
  if(path.endsWith('/prospects/list')){const input=JSON.parse(String(init?.body)) as {state:string;offset:number};reads.push(input);if(input.offset===50&&++pageTwoReads>1)return await fresh();return json({prospects:input.offset===0?first:[selected],hasMore:true});}
  throw Error('Unexpected request outside bounded read workflow');
 });
 const client=new BrowserClient({fetch:fetcher,storage:sessionStorage,manualActivityStorage:localStorage,navigate:vi.fn(),randomUUID:()=>id});clients.push(client);
 return {client,reads,fetcher,fresh:(next:()=>Promise<Response>)=>{fresh=next;}};
}
function navigate(name:string){fireEvent.click(within(screen.getByRole('navigation',{name:'Workspace sections'})).getByRole('button',{name}));}
async function pageTwo(f:ReturnType<typeof setup>,state='all'){
 render(<BrowserApp client={f.client}/>);await screen.findByText('No firms need attention in this snapshot.');navigate('Prospects');fireEvent.click(screen.getByRole('button',{name:'Retained review'}));
 await screen.findByRole('table');await waitFor(()=>expect(screen.getByRole('button',{name:'Next prospect page'}).hasAttribute('disabled')).toBe(false));
 if(state!=='all'){fireEvent.change(screen.getByLabelText('Manual state'),{target:{value:state}});await waitFor(()=>expect(screen.getByRole('button',{name:'Next prospect page'}).hasAttribute('disabled')).toBe(false));}
 fireEvent.click(screen.getByRole('button',{name:'Next prospect page'}));await screen.findByRole('heading',{name:selected.observedName});await waitFor(()=>expect(screen.getByRole('button',{name:'Open calling brief'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Open calling brief'}));
}
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());sessionStorage.clear();localStorage.clear();});
it('client-only bounded hint preserves strict server subjects and accepts legacy selections',()=>{
 const subject={kind:'candidate',candidateId:selected.candidateId,expectedCandidateRevision:selected.revision};
 expect(callingSelectionSchema.parse(subject)).toEqual(subject);
 expect(callingSelectionSchema.parse({...subject,prospectPage:{state:'kept',offset:50}})).toEqual({...subject,prospectPage:{state:'kept',offset:50}});
 for(const prospectPage of [{state:'all',offset:-1},{state:'all',offset:1000001},{state:'all',offset:1.5},{state:'unknown',offset:50},{state:'all',offset:50,prospects:[selected]}])expect(callingSelectionSchema.safeParse({...subject,prospectPage}).success).toBe(false);
 expect(callingSelectionSchema.safeParse({...subject,prospect:selected}).success).toBe(false);
 expect(callingSubjectSchema.safeParse({...subject,prospectPage:{state:'all',offset:50}}).success).toBe(false);
 expect(callingSelectionSchema.parse({kind:'firm',firmId:id})).toEqual({kind:'firm',firmId:id});
 expect(callingSelectionSchema.safeParse({kind:'firm',firmId:id,prospectPage:{state:'all',offset:50}}).success).toBe(false);
});
it.each(['all','kept'])('Prospects page two through actual shell freshly resolves only exact bounded %s page',async state=>{
 const f=setup();await pageTwo(f,state);
 const brief=await screen.findByRole('region',{name:'Current calling brief'});
 await within(brief).findByRole('heading',{name:selected.observedName});
 expect(within(brief).getByText(/Fresh retained source/u)).toBeTruthy();expect(within(brief).queryByText(/Fictional retained source/u)).toBeNull();
 expect(f.reads).toEqual([...(state==='kept'?[{state:'all',offset:0}]:[]),{state,offset:0},{state,offset:50},{state,offset:50}]);
 expect(screen.getByLabelText('Actual outcome').matches(':disabled')).toBe(false);
 expect(sessionStorage.length+localStorage.length).toBe(0);
 expect(f.fetcher.mock.calls.every(([url])=>/\/browser\/session|\/today\?|\/today\/actions\/v4|\/prospects\/list/u.test(String(url)))).toBe(true);
});
it.each(['revision','source','unavailable'] as const)('fresh %s change refuses exact brief without scanning another page',async kind=>{
 const f=setup();f.fresh(async()=>kind==='unavailable'?json({},500):json({prospects:kind==='source'?[]:[{...selected,revision:4}],hasMore:true}));await pageTwo(f);
 await screen.findByText(/Current brief unavailable or source changed/u);
 expect(screen.getByLabelText('Actual outcome').matches(':disabled')).toBe(true);
 expect(screen.queryByRole('link',{name:'Open source'})).toBeNull();expect(f.reads).toEqual([{state:'all',offset:0},{state:'all',offset:50},{state:'all',offset:50}]);
});
it.each([401,403,409])('fresh page auth refusal %s clears exact brief and selection',async status=>{
 const f=setup();f.fresh(async()=>json({},status));await pageTwo(f);await screen.findByRole('heading',{name:'Sign in'});
 expect(screen.queryByRole('region',{name:'Current calling brief'})).toBeNull();expect(screen.queryByText(selected.observedName)).toBeNull();expect(f.reads).toHaveLength(3);
});
it('late page-two read cannot replace a newly selected exact observation',async()=>{
 const f=setup(),held=deferred();f.fresh(()=>held.promise);await pageTwo(f);await waitFor(()=>expect(f.reads).toHaveLength(3));
 navigate('Prospects');fireEvent.click(screen.getByRole('button',{name:'Retained review'}));await screen.findByRole('table');await waitFor(()=>expect(screen.getByRole('button',{name:'Open calling brief'}).hasAttribute('disabled')).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Open calling brief'}));
 const brief=await screen.findByRole('region',{name:'Current calling brief'});await within(brief).findByRole('heading',{name:first[0]!.observedName});
 await act(async()=>{held.resolve(json({prospects:[selected],hasMore:true}));});
 expect(within(brief).queryByRole('heading',{name:selected.observedName})).toBeNull();expect(within(brief).getByRole('heading',{name:first[0]!.observedName})).toBeTruthy();
});
it('late hinted page read cannot restore private context after session invalidation',async()=>{
 const f=setup(),held=deferred();f.fresh(()=>held.promise);await pageTwo(f);await waitFor(()=>expect(f.reads).toHaveLength(3));
 await act(async()=>{f.client.invalidate();held.resolve(json({prospects:[selected],hasMore:true}));});
 expect(screen.queryByRole('region',{name:'Current calling brief'})).toBeNull();expect(screen.queryByText(selected.observedName)).toBeNull();expect(screen.getByRole('heading',{name:'Sign in'})).toBeTruthy();
});
it('same exact candidate with a replacement page hint fences the earlier page response',async()=>{
 const f=setup(),held=deferred();f.fresh(()=>held.promise);await f.client.refresh();
 const selection={kind:'candidate' as const,candidateId:selected.candidateId,expectedCandidateRevision:selected.revision,prospectPage:{state:'all' as const,offset:50}};
 const view=render(<CallingWorkspace client={f.client} selection={selection}/>);
 await screen.findByRole('heading',{name:selected.observedName});
 view.rerender(<CallingWorkspace client={f.client} selection={{...selection,prospectPage:{state:'kept',offset:50}}}/>);
 await waitFor(()=>expect(f.reads).toHaveLength(2));
 view.rerender(<CallingWorkspace client={f.client} selection={{...selection,prospectPage:{state:'all',offset:0}}}/>);
 await screen.findByText(/Current brief unavailable or source changed/u);
 await act(async()=>{held.resolve(json({prospects:[selected],hasMore:false}));});
 expect(screen.queryByRole('heading',{name:selected.observedName})).toBeNull();expect(screen.getByLabelText('Actual outcome').matches(':disabled')).toBe(true);
 expect(f.reads).toEqual([{state:'all',offset:50},{state:'kept',offset:50},{state:'all',offset:0}]);
});
