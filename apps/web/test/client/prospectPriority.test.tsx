// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {manualProspectSchema,prospectPriorityReviewSchema} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserManualProspects} from '../../src/client/BrowserManualProspects.tsx';
import {CallingQueue} from '../../src/client/CallingQueue.tsx';
import {PRIORITY_PENDING_KEY} from '../../src/client/ProspectPriorityCustody.ts';
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',at='2026-10-29T12:00:00.000Z';
const prospect=manualProspectSchema.parse({candidateId:id,revision:2,observedName:'Synthetic Residential Manager',website:null,locality:'Boston',region:'MA',observedPhone:null,phoneBasis:'unknown',sources:[{label:'Retained first-party source',url:'https://source.example.test/',observedAt:at}],sourceNotices:[],retainedAt:at,state:'kept',unknowns:['Phone unknown'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
const priority=prospectPriorityReviewSchema.parse({policyVersion:'prospect-priority-v1',band:'ordinary',fit:'unknown',value:'unknown',timing:'unknown',roles:[],roleState:'unknown',roleCandidates:[],roleCandidatesHasMore:false,nextAction:'review_fit',assessmentRevision:0,lastConsideredAt:null,consideredCount:0,reasons:[]});
const json=(body:unknown):Response=>Response.json(body);
const clients:BrowserClient[]=[];
function setup(roleCandidate=false){
 const storage=new Map<string,string>(),binding={getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,value);},removeItem:(key:string)=>{storage.delete(key);}};
 const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()};
 const reads:Record<string,unknown>[]=[],writes:Array<{path:string;body:Record<string,unknown>}>=[];let revision=0,lose=false,viewChanged=false,refuse=false;
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  const path=String(url);if(path==='/browser/session')return json(session);
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  if(path.endsWith('/priority/list')){reads.push(body);return json(viewChanged&&body['offset']!==0?{error:'view_changed'}:{prospects:[{prospect,priority:{...priority,assessmentRevision:revision,roleCandidates:roleCandidate?[{personId:other,personName:'Synthetic Operations Owner',relationshipId:other,relationshipRevision:3}]:[]}}],hasMore:true,viewRevision:'a'.repeat(64)});}
  if(path.endsWith('/priority/receipt'))return json(lose?{state:'unknown'}:{state:'accepted',result:{candidateId:id,candidateRevision:2,assessmentRevision:1}});
  if(path.endsWith('/priority/learning'))return json({from:body['from'],to:body['to'],considered:2,selected:1,observations:{conversation:1,no_answer:1,callback_requested:0,not_interested:0,unknown:1},reportedAttempts:2,unplacedReportedAttempts:1,elapsedMinutes:'unavailable',coverage:'current_retained_only',appropriatePerson:'unavailable',cohorts:[{fit:'unknown',value:'unknown',timing:'unknown',roles:[],reportedAttempts:2,unplacedReportedAttempts:1,considered:2,selected:1,conversation:1,noAnswer:1,unknown:1}],cohortsHasMore:false,paidAdoption:'unavailable',retention:'unavailable'});
  writes.push({path,body});expect(storage.get(PRIORITY_PENDING_KEY)).toBeTruthy();if(lose)throw Error('Lost response');if(refuse)return json({status:'refused',replayed:false,reason:'assessment_changed'});
  if(path.endsWith('/save'))revision++;
  return json({status:'accepted',replayed:false,result:{candidateId:id,candidateRevision:2,assessmentRevision:revision,...(path.endsWith('/consider')?{considerationId:other}:{})}});
 });
 const client=new BrowserClient({fetch,storage:binding,priorityStorage:binding,manualActivityStorage:binding,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);
 return {client,reads,writes,fetch,storage,lose:(value=true)=>{lose=value;},viewChanged:()=>{viewChanged=true;},refuse:()=>{refuse=true;}};
}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async(_name:string,_options:unknown,work:()=>Promise<unknown>)=>work())}});});
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());vi.unstubAllGlobals();});
async function ready(){await screen.findByRole('heading',{name:prospect.observedName});await waitFor(()=>expect(screen.getByRole('button',{name:'Keep'}).matches(':disabled')).toBe(false));}
it('loads priority without recording consideration, and paginates with the shared ordering revision',async()=>{
 const f=setup();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();expect(f.writes).toEqual([]);expect(f.storage.size).toBe(0);expect(screen.getByText('Ordinary prospect · intent unknown')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Next prospect page'}));await waitFor(()=>expect(f.reads).toHaveLength(2));expect(f.reads[1]).toEqual({state:'all',offset:50,viewRevision:'a'.repeat(64)});expect(f.writes).toEqual([]);
});
it('refuses changed pagination explicitly and refreshes from the first page without an old-list fallback',async()=>{
 const f=setup();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();f.viewChanged();fireEvent.click(screen.getByRole('button',{name:'Next prospect page'}));await screen.findByText(/Prospect order changed/u);expect(screen.queryByRole('heading',{name:prospect.observedName})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Refresh retained worklist'}));await ready();expect(f.reads.at(-1)).toEqual({state:'all',offset:0});expect(f.fetch.mock.calls.some(([url])=>String(url).endsWith('/prospects/list'))).toBe(false);
});
it('saves explicit human judgment against the exact candidate and source; no Person is invented',async()=>{
 const f=setup();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();fireEvent.click(screen.getByText('Review priority'));fireEvent.change(screen.getByLabelText('Residential-management fit'),{target:{value:'positive'}});fireEvent.click(screen.getByRole('button',{name:'Save priority assessment'}));
 await waitFor(()=>expect(f.writes).toHaveLength(1));expect(f.writes[0]).toEqual({path:'/browser/api/sourcing/candidates/prospects/priority/save',body:{candidateId:id,expectedCandidateRevision:2,expectedAssessmentRevision:0,fit:'positive',value:'unknown',timing:'unknown',sourceUrl:prospect.sources[0]!.url,roles:[],commandId:other}});await waitFor(()=>expect(f.storage.get(PRIORITY_PENDING_KEY)).toBeUndefined());
});
it('records consideration only on deliberate action, coalescing repeated clicks before dispatch',async()=>{
 const f=setup();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();const button=screen.getByRole('button',{name:'Select for research'});act(()=>{fireEvent.click(button);fireEvent.click(button);});await waitFor(()=>expect(f.writes).toHaveLength(1));expect(f.writes[0]?.body).toMatchObject({disposition:'selected',expectedAssessmentRevision:0});
});
it('retains opaque UNKNOWN custody and reconciles without resending or replacing the assessment',async()=>{
 const f=setup();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();f.lose();fireEvent.click(screen.getByRole('button',{name:'Save priority assessment'}));await screen.findByRole('button',{name:'Reconcile exact priority receipt'});
 expect(f.writes).toHaveLength(1);expect(f.storage.get(PRIORITY_PENDING_KEY)).not.toMatch(/source|Residential|positive|unknown|fit|timing|roles/u);fireEvent.click(screen.getByRole('button',{name:'Reconcile exact priority receipt'}));await screen.findByText(/Outcome remains UNKNOWN/u);expect(f.writes).toHaveLength(1);f.lose(false);fireEvent.click(screen.getByRole('button',{name:'Reconcile exact priority receipt'}));await waitFor(()=>expect(f.storage.get(PRIORITY_PENDING_KEY)).toBeUndefined());expect(f.writes).toHaveLength(1);
});
it('shows confirmed refusal without calling it UNKNOWN or retaining reconciled custody',async()=>{
 const f=setup();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();f.refuse();fireEvent.click(screen.getByRole('button',{name:'Mark considered'}));await screen.findByText(/Priority decision was refused/u);expect(f.storage.get(PRIORITY_PENDING_KEY)).toBeUndefined();expect(screen.queryByRole('button',{name:'Reconcile exact priority receipt'})).toBeNull();
});
it('Calling uses the same priority owner and preserves the exact selected subject',async()=>{
 const f=setup();await f.client.refresh();const select=vi.fn();render(<CallingQueue client={f.client} onSelect={select} disabled={false}/>);const button=await screen.findByRole('button',{name:/Synthetic Residential Manager/u});fireEvent.click(button);expect(select).toHaveBeenCalledWith({subject:{kind:'candidate',candidateId:id,expectedCandidateRevision:2},label:prospect.observedName,prospect});expect(f.reads[0]).toEqual({state:'kept',offset:0,includeManualPhone:true});expect(f.writes).toEqual([]);
});
it('clears decision form, pending custody and learning projection when authority changes',async()=>{
 const f=setup();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();fireEvent.click(screen.getByRole('button',{name:'Load recorded outcomes'}));await screen.findByLabelText('Recorded prospect outcomes');f.lose();fireEvent.click(screen.getByRole('button',{name:'Mark considered'}));await screen.findByRole('button',{name:'Reconcile exact priority receipt'});await act(async()=>{f.client.invalidate();});expect(screen.queryByLabelText('Prospect priority review')).toBeNull();expect(screen.queryByLabelText('Recorded prospect outcomes')).toBeNull();expect(f.storage.get(PRIORITY_PENDING_KEY)).toBeUndefined();
});

it('adds a buying-role hypothesis only through an existing supported Person choice',async()=>{
 const f=setup(true);await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();fireEvent.click(screen.getByText('Review priority'));fireEvent.change(screen.getByLabelText('Supported Person'),{target:{value:other}});fireEvent.change(screen.getByLabelText('Buying responsibility'),{target:{value:'budget_approver'}});fireEvent.click(screen.getByRole('button',{name:'Add buying role'}));fireEvent.click(screen.getByRole('button',{name:'Save priority assessment'}));await waitFor(()=>expect(f.writes).toHaveLength(1));expect(f.writes[0]?.body['roles']).toEqual([{personId:other,relationshipId:other,relationshipRevision:3,role:'budget_approver',basis:'hypothesis'}]);expect(JSON.stringify(f.writes)).not.toContain('Synthetic Operations Owner');
});

it('records stronger buying-role support only after an explicit human basis choice',async()=>{
 const f=setup(true);await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();
 fireEvent.click(screen.getByText('Review priority'));
 expect(screen.getByLabelText('Role evidence basis')).toHaveProperty('value','hypothesis');
 fireEvent.change(screen.getByLabelText('Supported Person'),{target:{value:other}});
 fireEvent.change(screen.getByLabelText('Role evidence basis'),{target:{value:'directly_confirmed'}});
 fireEvent.click(screen.getByRole('button',{name:'Add buying role'}));
 fireEvent.click(screen.getByRole('button',{name:'Save priority assessment'}));
 await waitFor(()=>expect(f.writes).toHaveLength(1));
 expect(f.writes[0]?.body['roles']).toEqual([{personId:other,relationshipId:other,relationshipRevision:3,role:'workflow_owner',basis:'directly_confirmed'}]);
});
