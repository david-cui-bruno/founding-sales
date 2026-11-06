// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {manualProspectSchema,pluralFirmPageResponseSchema,type CallingWrapInput} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import type {CallingContextData} from '../../src/client/CallingContext.tsx';
import {ProspectActivity} from '../../src/client/ProspectActivity.tsx';
import {ProspectConversation} from '../../src/client/ProspectConversation.tsx';
import {installCallingCustody} from '../../src/client/CallingPending.ts';
import {priorityFixturePage} from './support/priorityFixture.ts';
import {workspaceChoiceDisabled} from './support/workspaceChoice.ts';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',firstAttempt='00000000-0000-4000-8000-0000000000a1',secondAttempt='00000000-0000-4000-8000-0000000000a2',foreignFirm='00000000-0000-4000-8000-0000000000f2';
const at='2026-10-26T00:00:00.000Z',note='PRIVATE reported prose never restored';
const alpha=manualProspectSchema.parse({candidateId:id,revision:1,observedName:'Synthetic Alpha prospect',website:'https://synthetic.example.test/',locality:'Dallas',region:'TX',observedPhone:null,phoneBasis:'unknown',sources:[{label:'Synthetic retained source',url:'https://source.example.test/',observedAt:'2026-10-20T00:00:00.000Z'}],sourceNotices:[],retainedAt:'2026-10-20T00:00:00.000Z',state:'new',unknowns:['Phone unknown'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
const firm={id,name:'Fictional activity Firm',website:null,locality:null,regionCode:null,status:'active',assignedUserId:id,stageKey:null,opportunityStatus:null,controlMode:null,openedAt:null,timeZone:null,timeZoneUnresolvedReason:null,addressLine:null,postalCode:null,countryCode:'US',timeZoneConfidence:null,timeZoneSource:null,contacts:[],phoneRoutes:[],emailRoutes:[],aliases:[]};
const event=(key:string)=>({key,at,kind:'call' as const,code:null,detail:null,cursor:`cursor-${key}`});
const firmPage=(timeline:unknown,owner=firm)=>pluralFirmPageResponseSchema.parse({version:3,visibility:'assigned_or_admin',read:{visibility:'assigned_or_admin',firm:owner},opportunities:[],holds:[],followUpPermissions:[],...(timeline===undefined?{}:{timeline})});
const meta=(attemptId:string,revision=1,availability:'available'|'withdrawn'|'unavailable'='available')=>({candidateId:id,candidateRevision:revision,attemptId,activityRevision:1,recordedAt:at,updatedAt:at,availability});
const view=(attemptId:string,availability:'available'|'withdrawn'|'unavailable',revision=1)=>availability==='available'
 ?{...meta(attemptId,revision),performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'conversation',note,callback:null,qualification:'unverified',contactAuthority:'not_granted',reportBasis:'user_reported_unverified'}
 :availability==='withdrawn'?meta(attemptId,revision,'withdrawn'):{...meta(attemptId,revision,'unavailable'),reason:'source_changed_or_unavailable'};
const candidate=(revision:number):CallingContextData=>({entry:{subject:{kind:'candidate',candidateId:id,expectedCandidateRevision:revision},label:'Selected retained observation'}});
const firmContext:CallingContextData={entry:{subject:{kind:'firm',firmId:id},label:'Selected company'}};
const revisionOne=candidate(1),revisionTwo=candidate(2);
type Call={path:string;body:Record<string,unknown>};
type Route=(call:Call)=>Response|Promise<Response>|undefined;
const clients:BrowserClient[]=[];
function setup(role:'admin'|'salesperson'='admin'){
 const calls:Call[]=[];let route:Route=()=>undefined;
 const send=vi.fn<typeof fetch>(async(url,init)=>{
  const path=String(url);
  if(path==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role,revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+600000).toISOString()});
  const call={path,body:init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:{}};calls.push(call);
  const answer=route(call);if(answer)return answer;throw Error(`Unexpected route ${path}`);
 });
 const client=new BrowserClient({fetch:send,storage:localStorage,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);
 return {client,calls,on:(next:Route)=>{route=next;},kind:(suffix:string)=>calls.filter(call=>call.path.endsWith(suffix))};
}
const panel=():HTMLElement=>screen.getByRole('region',{name:'Company activity'});
const settled=()=>waitFor(()=>expect(panel().getAttribute('aria-busy')).toBe('false'));
const readButtons=()=>screen.queryAllByRole('button',{name:/Read report/u});
const stored=():string=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}});
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_n:string,_o:unknown,work:()=>Promise<unknown>)=>work()}});});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();sessionStorage.clear();vi.unstubAllGlobals();});

it('an observation reads only its exact candidate/revision reports through the existing owners, never a Firm or timeline',async()=>{
 const f=setup();f.on(({path})=>path.endsWith('/activity/list')?Response.json({activities:[meta(firstAttempt),meta(secondAttempt)],nextAfterId:null}):path.endsWith('/activity/read')?Response.json({activity:view(firstAttempt,'available')}):undefined);
 await f.client.refresh();render(<ProspectActivity client={f.client} context={revisionOne} isScopeCurrent={()=>true}/>);await settled();
 expect(f.calls).toHaveLength(1);expect(f.calls[0]!.path.endsWith('/sourcing/candidates/prospects/activity/list')).toBe(true);expect(f.calls[0]!.body).toEqual({candidateId:id,expectedCandidateRevision:1});
 expect(readButtons()).toHaveLength(2);expect(screen.queryByText(note)).toBeNull();
 fireEvent.click(readButtons()[0]!);await screen.findByText(note);
 expect(f.calls).toHaveLength(2);expect(f.calls[1]!.body).toEqual({candidateId:id,expectedCandidateRevision:1,attemptId:firstAttempt});
 expect(f.calls.some(call=>/firm-page|timeline/u.test(call.path))).toBe(false);expect(stored()).not.toContain(note);
});
it('a candidate report needs administrator access and reads nothing for a salesperson',async()=>{
 const f=setup('salesperson');f.on(()=>Response.json({activities:[],nextAfterId:null}));await f.client.refresh();
 render(<ProspectActivity client={f.client} context={revisionOne} isScopeCurrent={()=>true}/>);
 await act(async()=>{await Promise.resolve();});
 expect(f.calls).toHaveLength(0);expect(readButtons()).toHaveLength(0);
});
it.each(['withdrawn','unavailable'] as const)('a %s report never restores the private prose it once returned',async availability=>{
 const f=setup();let current:'available'|'withdrawn'|'unavailable'='available';
 f.on(({path})=>path.endsWith('/activity/list')?Response.json({activities:[meta(firstAttempt,1,current)],nextAfterId:null}):path.endsWith('/activity/read')?Response.json({activity:view(firstAttempt,current)}):undefined);
 await f.client.refresh();render(<ProspectActivity client={f.client} context={revisionOne} isScopeCurrent={()=>true}/>);await settled();
 fireEvent.click(readButtons()[0]!);await screen.findByText(note);
 current=availability;
 fireEvent.click(screen.getByRole('button',{name:'Refresh activity'}));await settled();
 expect(screen.queryByText(note)).toBeNull();expect(screen.queryByRole('article',{name:'Current manual report'})).toBeNull();
 fireEvent.click(readButtons()[0]!);await screen.findByRole('article',{name:'Current manual report'});
 expect(screen.queryByText(note)).toBeNull();expect(document.body.textContent).not.toContain(note);expect(stored()).not.toContain(note);
});
it('a report whose server answer names another attempt or revision is refused, not shown',async()=>{
 const f=setup();f.on(({path})=>path.endsWith('/activity/list')?Response.json({activities:[meta(firstAttempt)],nextAfterId:null}):path.endsWith('/activity/read')?Response.json({activity:view(secondAttempt,'available')}):undefined);
 await f.client.refresh();render(<ProspectActivity client={f.client} context={revisionOne} isScopeCurrent={()=>true}/>);await settled();
 fireEvent.click(readButtons()[0]!);await waitFor(()=>expect(f.kind('/activity/read')).toHaveLength(1));await settled();
 expect(screen.queryByText(note)).toBeNull();expect(screen.queryByRole('article',{name:'Current manual report'})).toBeNull();
});
it('a late response for the previous revision cannot replace the current revision rows',async()=>{
 const f=setup(),late=Promise.withResolvers<Response>();
 f.on(({path,body})=>path.endsWith('/activity/list')?body['expectedCandidateRevision']===1?late.promise:Response.json({activities:[meta(secondAttempt,2)],nextAfterId:null}):path.endsWith('/activity/read')?Response.json({activity:view(secondAttempt,'available',2)}):undefined);
 await f.client.refresh();const props={client:f.client,isScopeCurrent:()=>true};
 const {rerender}=render(<ProspectActivity {...props} context={revisionOne}/>);await waitFor(()=>expect(f.kind('/activity/list')).toHaveLength(1));
 rerender(<ProspectActivity {...props} context={revisionTwo}/>);await waitFor(()=>expect(readButtons()).toHaveLength(1));
 const reads=f.calls.length;
 await act(async()=>{late.resolve(Response.json({activities:[meta(firstAttempt,1),meta(secondAttempt,1)],nextAfterId:null}));await late.promise;});
 expect(readButtons()).toHaveLength(1);expect(f.calls).toHaveLength(reads);
 fireEvent.click(readButtons()[0]!);await waitFor(()=>expect(f.kind('/activity/read')).toHaveLength(1));expect(f.kind('/activity/read')[0]!.body).toEqual({candidateId:id,expectedCandidateRevision:2,attemptId:secondAttempt});
});
it('a conversation scope change fences a held read even when the subject is unchanged',async()=>{
 const f=setup(),held=Promise.withResolvers<Response>();let current=true;
 f.on(({path})=>path.endsWith('/activity/list')?held.promise:undefined);
 await f.client.refresh();render(<ProspectActivity client={f.client} context={revisionOne} isScopeCurrent={()=>current}/>);await waitFor(()=>expect(f.calls).toHaveLength(1));
 current=false;await act(async()=>{held.resolve(Response.json({activities:[meta(firstAttempt)],nextAfterId:null}));await held.promise;});
 expect(readButtons()).toHaveLength(0);expect(f.calls).toHaveLength(1);
});
it('revocation discards a held list read and requests nothing further',async()=>{
 const f=setup(),list=Promise.withResolvers<Response>();
 f.on(({path})=>path.endsWith('/activity/list')?list.promise:undefined);
 await f.client.refresh();render(<ProspectActivity client={f.client} context={revisionOne} isScopeCurrent={()=>true}/>);await waitFor(()=>expect(f.calls).toHaveLength(1));
 act(()=>{f.client.invalidate();});
 await act(async()=>{list.resolve(Response.json({activities:[meta(firstAttempt)],nextAfterId:null}));await list.promise;});
 expect(readButtons()).toHaveLength(0);expect(f.calls).toHaveLength(1);
});
it('revocation discards a held report read so its private prose is never rendered or stored',async()=>{
 const f=setup(),report=Promise.withResolvers<Response>();
 f.on(({path})=>path.endsWith('/activity/list')?Response.json({activities:[meta(firstAttempt)],nextAfterId:null}):path.endsWith('/activity/read')?report.promise:undefined);
 await f.client.refresh();render(<ProspectActivity client={f.client} context={revisionOne} isScopeCurrent={()=>true}/>);await settled();
 fireEvent.click(readButtons()[0]!);await waitFor(()=>expect(f.kind('/activity/read')).toHaveLength(1));
 act(()=>{f.client.invalidate();});const requests=f.calls.length;
 await act(async()=>{report.resolve(Response.json({activity:view(firstAttempt,'available')}));await report.promise;});
 expect(screen.queryByText(note)).toBeNull();expect(document.body.textContent).not.toContain(note);expect(f.calls).toHaveLength(requests);expect(stored()).not.toContain(note);
});
it('a failed or inconsistent candidate read is an error, distinguishable from a genuinely empty history',async()=>{
 const f=setup();let answer:()=>Response=()=>Response.json({activities:[],nextAfterId:null});f.on(({path})=>path.endsWith('/activity/list')?answer():undefined);
 await f.client.refresh();render(<ProspectActivity client={f.client} context={revisionOne} isScopeCurrent={()=>true}/>);await settled();
 expect(screen.queryAllByRole('status')).toHaveLength(0);
 for(const bad of [()=>new Response('{}',{status:500}),()=>Response.json({activities:[meta(firstAttempt,9)],nextAfterId:null}),()=>Response.json({unexpected:true})]){
  answer=bad;fireEvent.click(screen.getByRole('button',{name:'Refresh activity'}));await settled();
  expect(screen.queryAllByRole('status')).toHaveLength(1);expect(readButtons()).toHaveLength(0);
 }
 answer=()=>Response.json({activities:[meta(firstAttempt)],nextAfterId:null});fireEvent.click(screen.getByRole('button',{name:'Refresh activity'}));await settled();
 expect(screen.queryAllByRole('status')).toHaveLength(0);expect(readButtons()).toHaveLength(1);
});
it('a canonical timeline read validates the exact Firm and pages by its own cursor',async()=>{
 const f=setup();let page=firmPage({events:[event('one'),event('two')],nextBefore:'cursor-two'});f.on(({path})=>path.endsWith('/firm-page-v3')?Response.json(page):undefined);
 await f.client.refresh();render(<ProspectActivity client={f.client} context={firmContext} isScopeCurrent={()=>true}/>);await settled();
 expect(f.calls).toHaveLength(1);expect(f.calls[0]!.body).toMatchObject({firmId:id,include:['timeline']});expect(f.calls[0]!.body).not.toHaveProperty('timelineBefore');
 expect(timelineRows()).toHaveLength(2);
 page=firmPage({events:[event('three')],nextBefore:null});fireEvent.click(screen.getByRole('button',{name:/Older/u}));await settled();
 expect(f.calls[1]!.body).toMatchObject({firmId:id,include:['timeline'],timelineBefore:'cursor-two'});expect(timelineRows()).toHaveLength(1);expect(screen.queryByRole('button',{name:/Older/u})).toBeNull();
 expect(f.calls.some(call=>/activity/u.test(call.path))).toBe(false);
});
it.each([
 ['another Firm',()=>Response.json(firmPage({events:[event('one')],nextBefore:null},{...firm,id:foreignFirm}))],
 ['no timeline',()=>Response.json(firmPage(undefined))],
 ['a refused read',()=>new Response('{}',{status:500})],
] as const)('a Firm timeline read with %s is an error, never an empty history',async(_label,answer)=>{
 const f=setup();f.on(({path})=>path.endsWith('/firm-page-v3')?answer():undefined);
 await f.client.refresh();render(<ProspectActivity client={f.client} context={firmContext} isScopeCurrent={()=>true}/>);await settled();
 expect(timelineRows()).toHaveLength(0);expect(screen.queryAllByRole('status')).toHaveLength(1);
});
function timelineRows():HTMLElement[]{return screen.queryAllByRole('listitem');}

// --- conversation composition -------------------------------------------------------------
function conversation(){
 let lose=false;const f=setup();const writes:CallingWrapInput[]=[];
 f.on(({path,body})=>{
  if(path.endsWith('/prospects/priority/list'))return Response.json(priorityFixturePage({prospects:[alpha],hasMore:false}));
  if(path.endsWith('/prospects/list'))return Response.json({prospects:[alpha],hasMore:false});
  if(path.endsWith('/activity/list'))return Response.json({activities:[meta(firstAttempt)],nextAfterId:null});
  if(path.endsWith('/calling/wrap')){if(lose)throw Error('Response lost');const input=body as unknown as CallingWrapInput;writes.push(input);return Response.json({status:'accepted',replayed:false,result:{kind:'candidate',activity:{candidateId:id,candidateRevision:1,attemptId:(input as {attemptId?:string}).attemptId??firstAttempt,activityRevision:1},staleIntroductions:'not_applicable',followUp:{state:'not_requested'}}});}
  return undefined;
 });
 return {...f,writes,lose:()=>{lose=true;}};
}
async function openConversation(){
 const f=conversation();installCallingCustody(f.client);await f.client.refresh();
 render(<ProspectConversation client={f.client} selection={{kind:'candidate',candidateId:id,expectedCandidateRevision:1}}/>);
 await screen.findByRole('heading',{name:alpha.observedName});await waitFor(()=>expect(workspaceChoiceDisabled('Actual outcome')).toBe(false));return f;
}
const tab=(name:string)=>within(screen.getByRole('navigation',{name:'Company detail views'})).getByRole('button',{name});
it('Activity reads on opening and the private note and wrap stay the same mounted controls across every detail view',async()=>{
 const f=await openConversation();expect(f.kind('/activity/list')).toHaveLength(0);
 const notes=screen.getByLabelText('Private call notes') as HTMLTextAreaElement;fireEvent.change(notes,{target:{value:note}});
 fireEvent.click(tab('Activity'));await waitFor(()=>expect(f.kind('/activity/list')).toHaveLength(1));await settled();
 expect(f.kind('/activity/list')[0]!.body).toEqual({candidateId:id,expectedCandidateRevision:1});
 for(const name of ['Sources','Brief','Activity'])fireEvent.click(tab(name));
 expect(screen.getByLabelText('Private call notes')).toBe(notes);expect(notes.value).toBe(note);
});
it('a confirmed outcome refreshes the open Activity with a new read',async()=>{
 const f=await openConversation();fireEvent.click(tab('Activity'));await waitFor(()=>expect(f.kind('/activity/list')).toHaveLength(1));await settled();
 fireEvent.click(screen.getByRole('checkbox',{name:/I personally performed/u}));fireEvent.click(screen.getByRole('button',{name:'Save outcome'}));
 await screen.findByRole('article',{name:'Recorded calling outcome'});
 await waitFor(()=>expect(f.kind('/activity/list')).toHaveLength(2));expect(f.writes).toHaveLength(1);
});
it('an outcome whose receipt is UNKNOWN leaves the Activity read untouched until it is reconciled',async()=>{
 const f=await openConversation();fireEvent.click(tab('Activity'));await waitFor(()=>expect(f.kind('/activity/list')).toHaveLength(1));await settled();
 f.lose();fireEvent.click(screen.getByRole('checkbox',{name:/I personally performed/u}));fireEvent.click(screen.getByRole('button',{name:'Save outcome'}));
 await screen.findByRole('button',{name:'Recover exact Calling receipt'});
 expect(f.kind('/activity/list')).toHaveLength(1);expect(f.kind('/calling/wrap')).toHaveLength(1);
});
