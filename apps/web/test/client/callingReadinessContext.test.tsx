// @vitest-environment jsdom
import {useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingContext,type CallingContextData,type CallingContextEntry} from '../../src/client/CallingContext.tsx';
import {CallingExecution} from '../../src/client/CallingExecution.tsx';
import type {CallingExecutionPorts} from '../../src/client/CallingExecutionDispatch.ts';

const id='00000000-0000-4000-8000-000000000001';
const routeId='00000000-0000-4000-8000-000000000002';
const otherUser='00000000-0000-4000-8000-000000000003';
const clients:BrowserClient[]=[];
const unchanged=():boolean=>true;
const ignore=():void=>{};

function CurrentCalling({client,entry,ports}:{client:BrowserClient;entry:CallingContextEntry;ports:CallingExecutionPorts}){
 const [context,setContext]=useState<CallingContextData|null>(null);
 return <><CallingExecution client={client} context={context} paused={false} onBlockedChange={ignore} onLinkChange={ignore} isScopeCurrent={unchanged} ports={ports}/><CallingContext client={client} entry={entry} onReady={setContext}/></>;
}

async function fixture(){
 const now=Date.now(),expiresAt=new Date(now+60_000).toISOString(),at=new Date(now).toISOString();
 const firm={id,name:'Fictional source company',website:'https://office.example.test/',locality:'Providence',regionCode:'RI',status:'active',assignedUserId:id,stageKey:null,opportunityStatus:null,controlMode:null,openedAt:null,timeZone:'America/New_York',timeZoneUnresolvedReason:null,addressLine:'Fictional office',postalCode:'02901',countryCode:'US',timeZoneConfidence:'high',timeZoneSource:'recorded',callingPreparationExpiresAt:expiresAt,contacts:[],phoneRoutes:[{id:routeId,contactId:null,value:'+14015550123',eligibility:'candidate',version:1}],emailRoutes:[],aliases:[]};
 const page={version:3,visibility:'assigned_or_admin',read:{visibility:'assigned_or_admin',firm},opportunities:[],holds:[],followUpPermissions:[]};
 const identity={id,ownerUserId:id,e164:'+14015550124',label:null,verificationStatus:'unverified',enabled:false,verifiedAt:null,verifiedByUserId:null,verificationMethod:null,disabledAt:null,usedForCalls:true,createdAt:at};
 const advice={firmId:id,routeId,e164:firm.phoneRoutes[0]!.value,telUri:null,callable:true,reasons:[],firmTimeZone:'America/New_York',firmLocalTime:'11:00',at};
 const apiPaths:string[]=[];
 let userId=id,held:Promise<Response>|null=null,finish:((value:Response)=>void)|undefined;
 const fetcher=vi.fn<typeof fetch>(async(url)=>{
  const path=String(url);
  if(path==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+3_600_000).toISOString()});
  apiPaths.push(path);
  if(path==='/browser/api/crm/firm-page-v3')return Response.json(page);
  if(path==='/browser/api/calling-identities')return Response.json({identities:[identity]});
  if(path==='/browser/api/dial/check')return held??Response.json({advice});
  if(path===`/browser/api/calls/calling?firmId=${id}`)return Response.json({provider:'twilio',cadence:{unansweredAttempts:0,nextAttempt:1,limit:4,parked:false,refusal:null},voicemailTemplate:'Fictional',callerName:'Fictional',callbackNumber:identity.e164});
  throw Error('This read-only fixture has no call, token, outcome or acquisition endpoint');
 });
 const client=new BrowserClient({fetch:fetcher,storage:localStorage,navigate:vi.fn(),randomUUID:()=>id});clients.push(client);
 const ports={microphone:vi.fn(async()=>{}),device:vi.fn(async()=>{throw Error('No voice connection is permitted');})};
 await client.refresh();
 render(<CurrentCalling client={client} entry={{subject:{kind:'firm',firmId:id},label:'Selected company'}} ports={ports}/>);
 await screen.findByRole('heading',{name:firm.name});
 await waitFor(()=>expect(screen.getByRole('combobox',{name:'Browser calling identity'})).toHaveProperty('value',id));
 return {client,ports,apiPaths,expiresAt,
  hold:()=>{held=new Promise<Response>(resolve=>{finish=resolve;});},
  release:()=>{finish?.(Response.json({advice}));},
  changeActor:()=>{userId=otherUser;},
 };
}

function chooseRoute(){
 fireEvent.change(screen.getByRole('combobox',{name:'Browser call route'}),{target:{value:routeId}});
 fireEvent.click(screen.getByRole('checkbox',{name:/authorized to place and record/u}));
}

function expectNoCall(f:Awaited<ReturnType<typeof fixture>>){
 expect(f.ports.microphone).not.toHaveBeenCalled();expect(f.ports.device).not.toHaveBeenCalled();
 expect(f.apiPaths.every(path=>['/browser/api/crm/firm-page-v3','/browser/api/calling-identities','/browser/api/dial/check',`/browser/api/calls/calling?firmId=${id}`].includes(path))).toBe(true);
 expect(localStorage.length).toBe(0);
}

afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());localStorage.clear();vi.restoreAllMocks();});

it('keeps the selected route and explicit attestation while real session refreshes read readiness',async()=>{
 const f=await fixture();f.hold();chooseRoute();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));});
 await waitFor(()=>expect(f.apiPaths).toContain('/browser/api/dial/check'));
 expect(screen.getByRole('combobox',{name:'Browser call route'})).toHaveProperty('value',routeId);
 expect(screen.getByRole('checkbox',{name:/authorized to place and record/u})).toHaveProperty('checked',true);
 await act(async()=>{f.release();});
 await waitFor(()=>{
  expect(screen.getByRole('combobox',{name:'Browser call route'})).toHaveProperty('value',routeId);
  expect(screen.getByText(/Policy snapshot/u)).toBeTruthy();
 });
 expect(screen.getByRole('checkbox',{name:/authorized to place and record/u})).toHaveProperty('checked',true);
 expect(f.apiPaths).toContain('/browser/api/dial/check');expectNoCall(f);
});

it('still clears a selected route at source expiry and fences the held readiness result',async()=>{
 const f=await fixture();f.hold();chooseRoute();
 fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));
 await waitFor(()=>expect(f.apiPaths).toContain('/browser/api/dial/check'));
 vi.spyOn(Date,'now').mockReturnValue(Date.parse(f.expiresAt)+1);
 await act(async()=>{await f.client.refresh();f.release();});
 expect(screen.getByRole('combobox',{name:'Browser call route'})).toHaveProperty('value','');
 expect(screen.getByRole('checkbox',{name:/authorized to place and record/u})).toHaveProperty('checked',false);
 expect(screen.getByRole('heading',{name:'[source unavailable company]'})).toBeTruthy();
 expect(screen.queryByText(/Policy snapshot/u)).toBeNull();expectNoCall(f);
});

it('still clears private calling context on actor change and fences the held readiness result',async()=>{
 const f=await fixture();f.hold();chooseRoute();
 fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));
 await waitFor(()=>expect(f.apiPaths).toContain('/browser/api/dial/check'));
 f.changeActor();
 await act(async()=>{await expect(f.client.refresh()).rejects.toThrow();f.release();});
 expect(screen.queryByRole('combobox',{name:'Browser call route'})).toBeNull();
 expect(screen.queryByRole('heading',{name:'Fictional source company'})).toBeNull();
 expect(screen.queryByText(/Policy snapshot/u)).toBeNull();expectNoCall(f);
});
