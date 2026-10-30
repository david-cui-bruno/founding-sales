// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {preparedProspectBriefSchema,preparedProspectSummarySchema,type PreparedProspectSummary} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {PreparedProspects} from '../../src/client/PreparedProspects.tsx';
import {BrowserProspectsWorkspace} from '../../src/client/BrowserProspectsWorkspace.tsx';
const at='2026-10-30T12:00:00.000Z',id='10000000-0000-4000-8000-000000000001',run='10000000-0000-4000-8000-000000000002';
const revision='a'.repeat(64),expiry='2026-10-31T12:00:00.000Z';
const row=(index=1):PreparedProspectSummary=>preparedProspectSummarySchema.parse({target:{candidateId:`10000000-0000-4000-8000-${String(index).padStart(12,'0')}`,candidateRevision:2,runId:run},displayName:`Harbor Residential ${index}`,discoveryLabel:`Home | HRM ${index}`,website:'https://harbor.example.test/',targetingLocality:'Boston',targetingRegion:'MA',state:'prepared',summary:'Retained first-party residential management and maintenance workflow context.',unknowns:['Business email is unknown','Buying intent is unknown'],validUntil:expiry});
const brief=preparedProspectBriefSchema.parse({...row(),policyVersion:'prepared-prospect-v1',checkedAt:at,coverage:'complete_retained_pages',nextAction:'Research who owns maintenance intake and vendor coordination.',contactAuthority:'not_granted',passages:[
 {kind:'business',observationId:id,blockId:'business',url:'https://harbor.example.test/about',retrievedAt:at,quote:'Harbor Residential manages residential homes and apartments.'},
 {kind:'workflow',observationId:id,blockId:'workflow',url:'https://harbor.example.test/services',retrievedAt:at,quote:'The account manager coordinates tenant intake and outside vendors.'},
 {kind:'person',observationId:id,blockId:'person',url:'https://harbor.example.test/team',retrievedAt:at,quote:'Morgan Lane is listed as the owner.'},
 {kind:'location',observationId:id,blockId:'location',url:'https://harbor.example.test/contact',retrievedAt:at,quote:'Office: Cambridge, MA. Serving the Greater Boston area.'},
 {kind:'contact',observationId:id,blockId:'contact',url:'https://harbor.example.test/contact',retrievedAt:at,quote:'Please use the general office line for business questions.'},
]});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(yes=>{resolve=yes;});return {promise,resolve};}
function setup(){
 const values=new Map<string,string>(),requests:Array<{url:string;body:unknown}>=[];
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:vi.fn((key:string,value:string)=>{values.set(key,value);}),removeItem:(key:string)=>{values.delete(key);}};
 const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:'2026-11-01T12:00:00.000Z'};
 let pageRows=[row()],hasMore=false,listFailure:unknown|null=null,readResult:unknown=brief,readDelay:ReturnType<typeof deferred>|undefined,listDelay:ReturnType<typeof deferred>|undefined;
 const send=vi.fn<typeof fetch>(async(url,init)=>{
  if(url==='/browser/session')return json(session);
  const body:unknown=init?.body===undefined?undefined:JSON.parse(String(init.body));requests.push({url:String(url),body});
  if(url==='/browser/api/sourcing/prepared-prospects/list'){
   if(listDelay)return listDelay.promise;
   if(listFailure)return json(listFailure);
   return json({prospects:pageRows,hasMore,viewRevision:revision,checkedAt:at});
  }
  if(url==='/browser/api/sourcing/prepared-prospects/read')return readDelay?readDelay.promise:json(readResult);
  if(url==='/browser/api/today/actions/v4?include=callingPreparation')return json({version:4,workspaceId:id,businessTimeZone:'America/Chicago',asOf:at,actions:[],promiseCoverage:{scope:'current_authorized_work',truncated:false,nextAfterId:null}});
  throw Error('Unexpected route '+String(url));
 });
 const randomUUID=vi.fn(()=>crypto.randomUUID());
 const client=new BrowserClient({fetch:send,storage,navigate:vi.fn(),randomUUID});
 return {client,session,storage,randomUUID,requests,rows:(next:PreparedProspectSummary[],more=false)=>{pageRows=next;hasMore=more;},failList:(value:unknown)=>{listFailure=value;},read:(value:unknown)=>{readResult=value;},delayRead:()=>{readDelay=deferred();return readDelay;},delayList:()=>{listDelay=deferred();return listDelay;}};
}
async function mounted(workspace=false){vi.spyOn(Date,'now').mockReturnValue(Date.parse(at));const f=setup();await f.client.refresh();render(workspace?<BrowserProspectsWorkspace client={f.client}/>:<PreparedProspects client={f.client}/>);return f;}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();});

it('opens a useful company brief without email or canonical publication, using only the exact read endpoints',async()=>{
 const f=await mounted();await screen.findByRole('heading',{name:row().displayName});
 fireEvent.click(screen.getByRole('button',{name:'Open company brief for '+row().displayName}));
 const detail=await screen.findByRole('article',{name:'Prepared company brief'});
 expect(within(detail).getByRole('heading',{name:brief.displayName})).toBe(document.activeElement);
 for(const passage of brief.passages)expect(within(detail).getByText(passage.quote)).toBeTruthy();
 expect(within(detail).getByText('Business email is unknown')).toBeTruthy();
 expect(within(detail).getByText('Home | HRM 1')).toBeTruthy();
 expect(within(detail).getByText('Boston, MA')).toBeTruthy();
 expect(within(detail).getByText(/discovery hints.*do not confirm/iu)).toBeTruthy();
 expect(within(detail).getAllByRole('link').every(link=>link.getAttribute('referrerpolicy')==='no-referrer')).toBe(true);
 expect(screen.queryByRole('button',{name:/call|email|create firm|keep|send/iu})).toBeNull();
 expect(f.requests).toEqual([{url:'/browser/api/sourcing/prepared-prospects/list',body:{offset:0}},{url:'/browser/api/sourcing/prepared-prospects/read',body:row().target}]);
 expect(f.randomUUID).not.toHaveBeenCalled();expect(f.storage.setItem).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Back to companies'}));
 expect(screen.queryByRole('article',{name:'Prepared company brief'})).toBeNull();expect(screen.getByRole('heading',{name:'Prepared companies'})).toBe(document.activeElement);
 expect(f.requests).toHaveLength(2);f.client.dispose();
});

it('paginates bounded fifty-row pages with the view revision and keeps needs-research distinct',async()=>{
 const f=await mounted();await screen.findByRole('heading',{name:row().displayName});
 const first=Array.from({length:50},(_,index)=>row(index+1));f.rows(first,true);
 fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));await screen.findByRole('heading',{name:'Harbor Residential 50'});
 expect(screen.getAllByRole('button',{name:/Open company brief for/iu})).toHaveLength(50);
 const next={...row(51),state:'needs_research' as const,summary:'No usable retained pages support identity and fit.',validUntil:null};f.rows([next]);
 fireEvent.click(screen.getByRole('button',{name:'Next companies'}));await screen.findByRole('heading',{name:next.displayName});
 expect(screen.queryByRole('heading',{name:row().displayName})).toBeNull();expect(screen.getByText('Needs research')).toBeTruthy();
 expect(screen.getByText('0 prepared · 1 need research on this page. This is research supply, not a contact-ready count.')).toBeTruthy();
 expect(f.requests.at(-1)).toEqual({url:'/browser/api/sourcing/prepared-prospects/list',body:{offset:50,viewRevision:revision}});
 f.rows(first,true);fireEvent.click(screen.getByRole('button',{name:'Previous companies'}));await screen.findByRole('heading',{name:row().displayName});
 expect(f.requests.at(-1)).toEqual({url:'/browser/api/sourcing/prepared-prospects/list',body:{offset:0,viewRevision:revision}});f.client.dispose();
});

it('clears a changed list and offers a first-page refresh without invalidating the signed-in session',async()=>{
 const f=await mounted();await screen.findByRole('heading',{name:row().displayName});
 f.failList({error:'view_changed'});fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));
 await screen.findByText('The company list changed. Refresh companies to start from the first page.');
 expect(screen.queryByRole('heading',{name:row().displayName})).toBeNull();expect(f.client.current?.status).toBe('signed_in');expect(screen.getByRole('button',{name:'Refresh companies'})).toBeTruthy();f.client.dispose();
});

it.each(['candidate_changed','source_changed','source_expired'] as const)('clears stale company context on a %s product refusal while retaining sign-in',async error=>{
 const f=await mounted();await screen.findByRole('heading',{name:row().displayName});f.read({error});
 fireEvent.click(screen.getByRole('button',{name:'Open company brief for '+row().displayName}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh companies'}).hasAttribute('disabled')).toBe(false));
 expect(screen.queryByRole('heading',{name:row().displayName})).toBeNull();expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(f.client.current?.status).toBe('signed_in');f.client.dispose();
});

it('ignores a late exact-detail response after Back to companies',async()=>{
 const f=await mounted();await screen.findByRole('heading',{name:row().displayName});const held=f.delayRead();
 fireEvent.click(screen.getByRole('button',{name:'Open company brief for '+row().displayName}));await screen.findByText('Opening company brief…');
 await waitFor(()=>expect(f.requests).toHaveLength(2));fireEvent.click(screen.getByRole('button',{name:'Back to companies'}));
 await act(async()=>{held.resolve(json(brief));});
 expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(screen.getByRole('heading',{name:row().displayName})).toBeTruthy();f.client.dispose();
});

it('clears private context on identity invalidation and rejects a late read response',async()=>{
 const f=await mounted();await screen.findByRole('heading',{name:row().displayName});const held=f.delayRead();
 fireEvent.click(screen.getByRole('button',{name:'Open company brief for '+row().displayName}));await waitFor(()=>expect(f.requests).toHaveLength(2));
 await act(async()=>{f.client.invalidate();held.resolve(json(brief));});
 expect(screen.queryByText(brief.displayName)).toBeNull();expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(screen.getByText('Prepared company research requires current administrator access.')).toBeTruthy();f.client.dispose();
});

it('refuses an exact-detail response for another revision instead of showing its passages',async()=>{
 const f=await mounted();await screen.findByRole('heading',{name:row().displayName});f.read({...brief,target:{...brief.target,candidateRevision:3}});
 fireEvent.click(screen.getByRole('button',{name:'Open company brief for '+row().displayName}));await screen.findByText('The selected company changed. Refresh companies to read current research.');
 expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(screen.queryByRole('heading',{name:row().displayName})).toBeNull();f.client.dispose();
});

it('expires both an opened brief and its list without polling or re-fetching',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(at));const f=setup();f.rows([{...row(),validUntil:'2026-10-30T12:00:01.000Z'}]);f.read({...brief,validUntil:'2026-10-30T12:00:01.000Z'});
 await f.client.refresh();render(<PreparedProspects client={f.client}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
 fireEvent.click(screen.getByRole('button',{name:'Open company brief for '+row().displayName}));await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
 expect(screen.getByText(brief.passages[0]!.quote)).toBeTruthy();const calls=f.requests.length;
 await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
 expect(screen.queryByText(brief.displayName)).toBeNull();expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(screen.getByText('Research evidence expired. Refresh companies to read current sources.')).toBeTruthy();expect(f.requests).toHaveLength(calls);f.client.dispose();
});

it('uses company preparation as the default while keeping qualified publication requests accessible',async()=>{
 const f=await mounted(true);await screen.findByRole('heading',{name:row().displayName});
 expect(f.requests.map(request=>request.url)).toEqual(['/browser/api/sourcing/prepared-prospects/list']);
 fireEvent.click(screen.getByRole('button',{name:'Qualified publications'}));await screen.findByRole('button',{name:'Refresh action queue'});
 await waitFor(()=>expect(f.requests.map(request=>request.url)).toContain('/browser/api/today/actions/v4?include=callingPreparation'));
 expect(screen.getByText('Qualified selection and existing research requests')).toBeTruthy();f.client.dispose();
});
it('preserves inherited source notices in both the page and selected brief without making unsafe links',async()=>{
 const f=await mounted();await screen.findByRole('heading',{name:row().displayName});
 const sourceNotices=[{label:'Fictional retained attribution',url:'https://source.example.test/license'},{label:'Literal source notice',url:'javascript:alert(1)'}];
 f.rows([{...row(),sourceNotices}]);fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));
 await screen.findByText(sourceNotices[0]!.label);expect(screen.getByText(sourceNotices[1]!.label).closest('a')).toBeNull();
 f.read({...brief,sourceNotices});fireEvent.click(screen.getByRole('button',{name:'Open company brief for '+row().displayName}));
 const detail=await screen.findByRole('article',{name:'Prepared company brief'});
 expect(within(detail).getByRole('link',{name:sourceNotices[0]!.label}).getAttribute('href')).toBe(sourceNotices[0]!.url);
 expect(within(detail).getByText(sourceNotices[1]!.label).closest('a')).toBeNull();f.client.dispose();
});
