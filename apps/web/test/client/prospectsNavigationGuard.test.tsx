// @vitest-environment jsdom
import {priorityFixturePage} from './support/priorityFixture.ts';
import {chooseWorkspace,workspaceChoiceDisabled,workspaceChoiceValue} from './support/workspaceChoice.ts';
import {webcrypto} from 'node:crypto';
import type {EventEmitter} from 'node:events';
import {useState} from 'react';
import {afterEach,beforeEach,expect,it,vi,type Mock} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {manualProspectSchema,type CallingWrapInput} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {ProspectConversation} from '../../src/client/ProspectConversation.tsx';
import {WorkspaceNavigationGuard,useWorkspaceNavigation} from '../../src/client/WorkspaceNavigationGuard.tsx';
import type {CallingSelection} from '../../src/client/workspaceNavigation.ts';
import {CALLING_PENDING_KEY,installCallingCustody} from '../../src/client/CallingPending.ts';
import {installCallingExecutionCustody} from '../../src/client/CallingExecutionPending.ts';
import type {CallingVoiceCall,CallingVoiceEvent} from '../../src/client/CallingVoiceDevice.ts';
const sdk=vi.hoisted(()=>({instances:[] as (EventEmitter&{destroy:Mock})[],connect:vi.fn<()=>Promise<CallingVoiceCall>>()}));
vi.mock('@twilio/voice-sdk',async()=>{const {EventEmitter}=await import('node:events');return {Device:class extends EventEmitter{constructor(){super();sdk.instances.push(this);}connect(){return sdk.connect();}destroy=vi.fn();}};});
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',routeId='00000000-0000-4000-8000-000000000003',sessionId='00000000-0000-4000-8000-000000000004';
const at='2026-10-26T00:00:00.000Z';
const alpha=manualProspectSchema.parse({candidateId:id,revision:1,observedName:'Synthetic Alpha prospect',website:'https://synthetic.example.test/',locality:'Dallas',region:'TX',observedPhone:null,phoneBasis:'unknown',sources:[{label:'Synthetic retained source',url:'https://source.example.test/',observedAt:'2026-10-20T00:00:00.000Z'}],sourceNotices:[],retainedAt:'2026-10-20T00:00:00.000Z',state:'new',unknowns:['Phone unknown'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
const beta=manualProspectSchema.parse({...alpha,candidateId:other,observedName:'Synthetic Beta prospect'});
const firm={id,name:'Fictional guard Firm',website:null,locality:null,regionCode:null,status:'active',assignedUserId:id,stageKey:null,opportunityStatus:null,controlMode:null,openedAt:null,timeZone:null,timeZoneUnresolvedReason:null,addressLine:null,postalCode:null,countryCode:'US',timeZoneConfidence:null,timeZoneSource:null,contacts:[],phoneRoutes:[{id:routeId,contactId:null,value:'+12145550123',eligibility:'usable',version:1}],emailRoutes:[],aliases:[]};
const page={version:3,visibility:'assigned_or_admin',read:{visibility:'assigned_or_admin',firm},opportunities:[],holds:[],followUpPermissions:[]};
const identity={id,ownerUserId:id,e164:'+12145550124',label:null,verificationStatus:'verified',enabled:true,verifiedAt:at,verifiedByUserId:id,verificationMethod:'owner_attestation',disabledAt:null,usedForCalls:true,createdAt:at};
const alphaSelection:CallingSelection={kind:'candidate',candidateId:id,expectedCandidateRevision:1},betaSelection:CallingSelection={kind:'candidate',candidateId:other,expectedCandidateRevision:1},firmSelection:CallingSelection={kind:'firm',firmId:id};
const note='PRIVATE unsaved call note';
const clients:BrowserClient[]=[];
function setup(){
 let gate:PromiseWithResolvers<void>|null=null;const routes:string[]=[],writes:CallingWrapInput[]=[];
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  const path=String(url);routes.push(path);const expiresAt=new Date(Date.now()+60000).toISOString();
  if(path==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+600000).toISOString()});
  if(path.endsWith('/prospects/priority/list'))return Response.json(priorityFixturePage({prospects:[alpha,beta],hasMore:false}));
  if(path.endsWith('/prospects/list'))return Response.json({prospects:[alpha,beta],hasMore:false});
  if(path.endsWith('/firm-page-v3'))return Response.json(page);
  if(path.endsWith('/calling-identities'))return Response.json({identities:[identity]});
  if(path.includes('/calls/calling?'))return Response.json({provider:'twilio',cadence:{unansweredAttempts:0,nextAttempt:1,limit:4,parked:false,refusal:null},voicemailTemplate:'Neutral',callerName:'Fictional user',callbackNumber:null});
  if(path.endsWith('/calls/access-token'))return Response.json({token:'EPHEMERAL_TOKEN_NEVER_PERSIST',identity:id,expiresAt});
  if(path.endsWith('/calls/session'))return Response.json({status:'accepted',replayed:false,result:{sessionId,expiresAt}});
  if(path.endsWith('/calling/execution/receipt'))return Response.json({state:'accepted',firmId:id,sessionId,expiresAt,status:'completed',canReconnect:false});
  if(path.endsWith('/calling/wrap')){
   const input=JSON.parse(String(init?.body)) as CallingWrapInput;writes.push(input);if(gate)await gate.promise;
   return Response.json({status:'accepted',replayed:false,result:input.kind==='candidate'?{kind:'candidate',activity:{candidateId:input.candidateId,candidateRevision:1,attemptId:input.attemptId,activityRevision:1},staleIntroductions:'not_applicable',followUp:{state:'not_requested'}}:{kind:'firm',firmId:id,callLogId:other,staleIntroductions:'stopped',attention:[],followUp:{state:'not_requested'}}});
  }
  throw Error(`Unexpected route ${path}`);
 });
 const client=new BrowserClient({fetch:fetcher,storage:localStorage,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);installCallingCustody(client);installCallingExecutionCustody(client);
 return {client,routes,writes,hold:()=>{gate=Promise.withResolvers<void>();return gate;}};
}
/** A Today-style entry point: like BrowserApp it navigates only when every mounted owner permits leaving. */
function Shell({client,first,onSelect}:{client:BrowserClient;first:CallingSelection;onSelect:(selection:CallingSelection|null)=>void}){
 const canLeave=useWorkspaceNavigation(),[selection,setSelection]=useState<CallingSelection|null>(first);
 return <><button onClick={()=>{if(canLeave())setSelection(betaSelection);}}>Open Beta from Today</button><ProspectConversation client={client} selection={selection} onSelectionChange={next=>{onSelect(next);setSelection(next);}}/></>;
}
const notes=():HTMLTextAreaElement=>screen.getByLabelText('Private call notes') as HTMLTextAreaElement;
async function open(first:CallingSelection){
 const f=setup(),onSelect=vi.fn<(selection:CallingSelection|null)=>void>();await f.client.refresh();
 render(<WorkspaceNavigationGuard><Shell client={f.client} first={first} onSelect={onSelect}/></WorkspaceNavigationGuard>);
 await screen.findByRole('heading',{name:first.kind==='firm'?firm.name:alpha.observedName});await waitFor(()=>expect(workspaceChoiceDisabled('Actual outcome')).toBe(false));
 return {...f,onSelect};
}
beforeEach(()=>{
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('isSecureContext',true);
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:string,_options:unknown,work:(lock:unknown)=>Promise<unknown>)=>work({mode:'exclusive'})}});
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn(async()=>({getTracks:()=>[]}))}});
 sdk.instances.length=0;sdk.connect.mockReset();
});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();sessionStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('a cancelled discard keeps the selected company, the exact typed notes and every read unchanged',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const f=await open(alphaSelection);const row=await screen.findByRole('button',{name:/Synthetic Beta prospect/u});
 fireEvent.change(notes(),{target:{value:note}});const reads=f.routes.length;
 fireEvent.click(row);
 expect(confirm).toHaveBeenCalledTimes(1);
 expect(screen.getByRole('heading',{name:alpha.observedName})).toBeTruthy();expect(screen.queryByRole('heading',{name:beta.observedName})).toBeNull();expect(notes().value).toBe(note);
 expect(f.onSelect).not.toHaveBeenCalled();expect(f.routes).toHaveLength(reads);expect(f.writes).toHaveLength(0);
});
it('an accepted discard explicitly drops the notes and opens the other company empty without a write',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);const f=await open(alphaSelection);const row=await screen.findByRole('button',{name:/Synthetic Beta prospect/u});
 fireEvent.change(notes(),{target:{value:note}});
 fireEvent.click(row);
 expect(confirm).toHaveBeenCalledTimes(1);
 await screen.findByRole('heading',{name:beta.observedName});expect(screen.queryByRole('heading',{name:alpha.observedName})).toBeNull();
 expect(f.onSelect).toHaveBeenCalledExactlyOnceWith({kind:'candidate',candidateId:other,expectedCandidateRevision:1});
 await waitFor(()=>expect(workspaceChoiceDisabled('Actual outcome')).toBe(false));expect(notes().value).toBe('');expect(screen.queryByDisplayValue(note)).toBeNull();
 expect(f.writes).toHaveLength(0);expect(localStorage.getItem(CALLING_PENDING_KEY)).toBeNull();
});
it('a pending outcome write refuses another company without a prompt, and the held write still resolves to its receipt',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);const f=await open(alphaSelection);const held=f.hold();
 fireEvent.click(screen.getByRole('checkbox',{name:/I personally performed/u}));fireEvent.click(screen.getByRole('button',{name:'Save outcome'}));await waitFor(()=>expect(f.writes).toHaveLength(1));
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open Beta from Today'}));});
 expect(confirm).not.toHaveBeenCalled();expect(screen.getByRole('heading',{name:alpha.observedName})).toBeTruthy();expect(screen.queryByRole('heading',{name:beta.observedName})).toBeNull();expect(f.onSelect).not.toHaveBeenCalled();expect(f.writes).toHaveLength(1);
 await act(async()=>{held.resolve();});
 await screen.findByRole('article',{name:'Recorded calling outcome'});expect(f.writes).toHaveLength(1);expect(f.writes[0]).toMatchObject({kind:'candidate',candidateId:id,expectedCandidateRevision:1});expect(screen.getByRole('heading',{name:alpha.observedName})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Open Beta from Today'}));await screen.findByRole('heading',{name:beta.observedName});expect(confirm).not.toHaveBeenCalled();expect(f.writes).toHaveLength(1);
});
it('an active browser call refuses another company, keeps a note typed while live and never touches the SDK call before an explicit hang-up',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
 const events=new Map<CallingVoiceEvent,(detail?:unknown)=>void>(),call={on:vi.fn((event:CallingVoiceEvent,listener:(detail?:unknown)=>void)=>{events.set(event,listener);}),mute:vi.fn(),disconnect:vi.fn()};sdk.connect.mockResolvedValue(call);
 const f=await open(firmSelection);await waitFor(()=>expect(workspaceChoiceValue('Browser calling identity')).toBe(id));
 chooseWorkspace('Browser call route',routeId);fireEvent.click(screen.getByRole('button',{name:'Call in browser'}));
 await waitFor(()=>expect(events.has('accept')).toBe(true));await act(async()=>{events.get('accept')?.();});await screen.findByText(/Say when they answer/u);
 expect(workspaceChoiceDisabled('Actual outcome')).toBe(true);expect(notes().hasAttribute('disabled')).toBe(false);
 fireEvent.change(notes(),{target:{value:note}});const row=await screen.findByRole('button',{name:/Synthetic Beta prospect/u});
 await act(async()=>{fireEvent.click(row);});
 expect(confirm).not.toHaveBeenCalled();expect(f.onSelect).not.toHaveBeenCalled();expect(screen.getByRole('heading',{name:firm.name})).toBeTruthy();expect(notes().value).toBe(note);
 expect(call.disconnect).not.toHaveBeenCalled();expect(sdk.instances[0]!.destroy).not.toHaveBeenCalled();expect(sdk.connect).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'Hang up / abandon setup'}));await waitFor(()=>expect(call.disconnect).toHaveBeenCalledTimes(1));
 fireEvent.click(await screen.findByRole('button',{name:'Check exact call receipt'}));await screen.findByRole('button',{name:'Finish terminated call handoff'});
 expect(notes().value).toBe(note);chooseWorkspace('Actual outcome','not_interested');fireEvent.click(screen.getByRole('checkbox',{name:/personally performed/u}));fireEvent.click(screen.getByRole('button',{name:'Save outcome'}));
 await screen.findByRole('article',{name:'Recorded calling outcome'});expect(f.writes).toHaveLength(1);expect(f.writes[0]).toMatchObject({kind:'firm',firmId:id,report:{callSessionId:sessionId,routeId,outcome:'not_interested',note}});
});
it('session revocation clears unsaved notes without consulting the discard confirmation',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);const f=await open(alphaSelection);
 fireEvent.change(notes(),{target:{value:note}});
 await act(async()=>{f.client.invalidate();});
 await screen.findByText('Sign in to review current prospects.');
 expect(confirm).not.toHaveBeenCalled();expect(screen.queryByLabelText('Private call notes')).toBeNull();expect(screen.queryByDisplayValue(note)).toBeNull();expect(f.writes).toHaveLength(0);expect(localStorage.getItem(CALLING_PENDING_KEY)).toBeNull();
});
