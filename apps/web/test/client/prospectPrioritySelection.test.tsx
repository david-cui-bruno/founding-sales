// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {manualProspectSchema,prospectPriorityReviewSchema} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserManualProspects} from '../../src/client/BrowserManualProspects.tsx';
import {PRIORITY_PENDING_KEY} from '../../src/client/ProspectPriorityCustody.ts';
const firstId='10000000-0000-4000-8000-000000000001',secondId='10000000-0000-4000-8000-000000000002',commandId='10000000-0000-4000-8000-000000000003';
const at='2026-10-29T12:00:00.000Z';
const rows=['First synthetic manager','Second synthetic manager'].map((observedName,index)=>manualProspectSchema.parse({candidateId:index===0?firstId:secondId,revision:2,observedName,website:null,locality:'Boston',region:'MA',observedPhone:null,phoneBasis:'unknown',sources:[{label:'Retained source',url:'https://source.example.test/',observedAt:at}],sourceNotices:[],retainedAt:at,state:'kept',unknowns:['Phone unknown'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'}));
const clients:BrowserClient[]=[];
function fixture(){
 const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};
 const writes:Record<string,unknown>[]=[],saved=new Set<string>();let reversed=false;let release:()=>void=()=>{throw Error('No pending save');};
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  const path=String(url);if(path==='/browser/session')return Response.json({status:'signed_in',workspaceId:firstId,userId:firstId,deviceId:firstId,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()});
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  if(path.endsWith('/priority/list'))return Response.json({prospects:(reversed?[...rows].reverse():rows).map(prospect=>({prospect,priority:prospectPriorityReviewSchema.parse({policyVersion:'prospect-priority-v1',band:saved.has(prospect.candidateId)?'evidence_supported':'ordinary',fit:saved.has(prospect.candidateId)?'positive':'unknown',value:'unknown',timing:'unknown',roles:[],roleState:'unknown',roleCandidates:[],roleCandidatesHasMore:false,nextAction:'review_fit',assessmentRevision:saved.has(prospect.candidateId)?1:0,lastConsideredAt:null,consideredCount:0,reasons:[]})})),hasMore:false,viewRevision:'a'.repeat(64)});
  if(path.endsWith('/priority/save')){writes.push(body);await new Promise<void>(resolve=>{release=()=>{saved.add(String(body['candidateId']));resolve();};});return Response.json({status:'accepted',replayed:false,result:{candidateId:body['candidateId'],candidateRevision:2,assessmentRevision:1}});}
  if(path.endsWith('/priority/receipt'))return Response.json({state:'accepted',result:{candidateId:firstId,candidateRevision:2,assessmentRevision:1}});
  throw Error('Unexpected fixture request');
 });
 const client=new BrowserClient({fetch,storage,priorityStorage:storage,manualActivityStorage:storage,navigate:vi.fn(),randomUUID:()=>commandId});clients.push(client);
 return {client,writes,data,reverse:()=>{reversed=true;},release:()=>release()};
}
async function ready():Promise<void>{await screen.findByRole('heading',{name:rows[0]!.observedName});await waitFor(()=>expect(screen.getByRole('button',{name:'Keep'}).matches(':disabled')).toBe(false));}
function select(index:number):void{fireEvent.click(document.getElementById(`manual-row-${rows[index]!.candidateId}`)!);}
async function explicitlySelectFirst():Promise<void>{select(1);await screen.findByRole('heading',{name:rows[1]!.observedName});select(0);await screen.findByRole('heading',{name:rows[0]!.observedName});}
function save():void{fireEvent.change(screen.getByLabelText('Residential-management fit'),{target:{value:'positive'}});fireEvent.click(screen.getByRole('button',{name:'Save priority assessment'}));}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async(_name:string,_options:unknown,work:()=>Promise<unknown>)=>work())}});});
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());vi.unstubAllGlobals();});
it('keeps the current exact row actionable after another click on that row',async()=>{
 const f=fixture();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();await explicitlySelectFirst();select(0);save();
 await waitFor(()=>expect(f.writes).toHaveLength(1));await act(async()=>{f.release();});await waitFor(()=>expect(f.data.get(PRIORITY_PENDING_KEY)).toBeUndefined());
 await waitFor(()=>expect(screen.getByRole('button',{name:'Mark considered'}).matches(':disabled')).toBe(false));
});
it('preserves an in-flight current-row command and its result across a same-row click',async()=>{
 const f=fixture();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();await explicitlySelectFirst();save();await waitFor(()=>expect(f.writes).toHaveLength(1));select(0);
 await act(async()=>{f.release();});await waitFor(()=>expect(f.data.get(PRIORITY_PENDING_KEY)).toBeUndefined());expect(screen.queryByRole('button',{name:'Reconcile exact priority receipt'})).toBeNull();await waitFor(()=>expect(screen.getByRole('button',{name:'Mark considered'}).matches(':disabled')).toBe(false));expect(f.writes).toHaveLength(1);
});
it('still revokes a different-record continuation synchronously and retains exact receipt recovery',async()=>{
 const f=fixture();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();await explicitlySelectFirst();save();await waitFor(()=>expect(f.writes).toHaveLength(1));select(1);await screen.findByRole('heading',{name:rows[1]!.observedName});
 await act(async()=>{f.release();});expect(screen.queryByRole('heading',{name:rows[0]!.observedName})).toBeNull();expect(f.data.get(PRIORITY_PENDING_KEY)).toBeTruthy();expect(f.writes).toHaveLength(1);
 const reconcile=screen.getByRole('button',{name:'Reconcile exact priority receipt'});await waitFor(()=>expect(reconcile.matches(':disabled')).toBe(false));fireEvent.click(reconcile);await waitFor(()=>expect(f.data.get(PRIORITY_PENDING_KEY)).toBeUndefined());await screen.findByRole('heading',{name:rows[1]!.observedName});expect(f.writes).toHaveLength(1);
});
it('focuses the current row on mobile without clearing its unsaved priority review',async()=>{
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true})));vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{callback(0);return 0;});
 const f=fixture();await f.client.refresh();render(<BrowserManualProspects client={f.client}/>);await ready();fireEvent.change(screen.getByLabelText('Residential-management fit'),{target:{value:'positive'}});select(0);
 expect(screen.getByRole('button',{name:'Focus'}).getAttribute('aria-pressed')).toBe('true');expect(screen.getByLabelText('Residential-management fit')).toHaveProperty('value','positive');expect(f.writes).toEqual([]);
 f.reverse();fireEvent.click(screen.getByRole('button',{name:'Refresh retained worklist'}));await screen.findByRole('heading',{name:rows[0]!.observedName});
});
