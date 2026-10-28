// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import type {z} from 'zod';
import type {dialCheckResponseSchema,CallingIdentityDto,CallingStatusResponse} from '@fss/contracts';
type Advice=z.infer<typeof dialCheckResponseSchema>['advice'];
const firm={id:'00000000-0000-4000-8000-000000000001',name:'Fictional readiness Firm',website:null,locality:null,regionCode:null,status:'active',assignedUserId:'00000000-0000-4000-8000-000000000001',stageKey:null,opportunityStatus:null,controlMode:null,openedAt:null,timeZone:null,timeZoneUnresolvedReason:null,addressLine:null,postalCode:null,countryCode:'US',timeZoneConfidence:null,timeZoneSource:null,contacts:[],phoneRoutes:[],emailRoutes:[],aliases:[]};
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {CallingReadiness} from '../../src/client/CallingReadiness.tsx';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const at='2026-10-27T15:00:00.000Z',route={id,version:1,value:'+14015550187'};
const identity:CallingIdentityDto={id,ownerUserId:id,e164:'+14015550100',label:'Fictional',verificationStatus:'verified',enabled:true,verifiedAt:at,verifiedByUserId:id,verificationMethod:'owner_attestation',disabledAt:null,usedForCalls:true,createdAt:at};
const advice:Advice={firmId:id,routeId:id,e164:route.value,telUri:null,callable:true,reasons:[],firmTimeZone:'America/New_York',firmLocalTime:'11:00',at};
const status:CallingStatusResponse={provider:'twilio',cadence:{unansweredAttempts:0,nextAttempt:1,limit:4,parked:false,refusal:null},voicemailTemplate:'Fictional',callerName:'Fictional',callbackNumber:identity.e164};
const clients:BrowserClient[]=[];
function fixture(){
 const values:{advice:Advice;status:unknown;identities:CallingIdentityDto[];routeVersion:number}={advice:{...advice},status,identities:[identity],routeVersion:1};
 let wait:Promise<Response>|null=null;
 const send=vi.fn<typeof fetch>(async(url)=>{
  if(url==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()});
  if(String(url).endsWith('/dial/check'))return wait??Response.json({advice:values.advice});
  if(String(url).includes('/calls/calling?'))return Response.json(values.status);
  if(String(url).endsWith('/calling-identities'))return Response.json({identities:values.identities});
  if(String(url).endsWith('/crm/firm-page-v3'))return Response.json({version:3,visibility:'assigned_or_admin',read:{visibility:'assigned_or_admin',firm:{...firm,phoneRoutes:[{...route,version:values.routeVersion,contactId:null,eligibility:'usable'}]}},opportunities:[],holds:[],followUpPermissions:[]});
  throw Error('Unexpected effect or route');
 });
 const client=new BrowserClient({fetch:send,storage:localStorage,navigate:vi.fn(),randomUUID:()=>id});clients.push(client);
 const props={client,firmId:id,route,identityId:id,disabled:false,isScopeCurrent:()=>true};
 return {client,send,values,props,hold:()=>{let resolve!:(response:Response)=>void;wait=new Promise<Response>(yes=>{resolve=yes;});return resolve;}};
}
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();vi.useRealTimers();});
it('reads only on explicit selection, before any microphone, token, session or outcome effect',async()=>{
 const f=fixture();await f.client.refresh();render(<CallingReadiness {...f.props}/>);expect(f.send).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));
 await screen.findByText(/Policy snapshot/u);expect(f.send).toHaveBeenCalledTimes(9);
 expect(f.send.mock.calls.filter(([url])=>url!=='/browser/session').map(([url,init])=>[url,init?.method])).toEqual([
  ['/browser/api/dial/check','POST'],[`/browser/api/calls/calling?firmId=${id}`,'GET'],['/browser/api/calling-identities','GET'],['/browser/api/crm/firm-page-v3','POST'],
 ]);
 expect(JSON.parse(String(f.send.mock.calls.find(([url])=>String(url).endsWith('/dial/check'))?.[1]?.body))).toEqual({firmId:id,routeId:id});
 expect(screen.getByText(/grants no permission to call or record/u)).toBeTruthy();expect(localStorage.length).toBe(0);
});
it.each(['calling_off','integration_unconfigured'] as const)('shows the exact %s provider blocker without inventing a National DNC prerequisite',async reason=>{
 const f=fixture();f.values.status={availability:'unavailable',reason};f.values.advice.nationalDnc={status:'unknown',basis:null,receiptId:null,warning:null};
 await f.client.refresh();render(<CallingReadiness {...f.props}/>);fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));
 await screen.findByText(reason==='calling_off'?/Browser calling is off/u:/provider is not configured/u);expect(screen.queryByText(/current clearance is not established/u)).toBeNull();
 expect(screen.queryByText(/checked clear/u)).toBeNull();
});
it('preserves a retained registry match and policy/cadence/identity blockers without a ready verdict',async()=>{
 const f=fixture();f.values.advice={...advice,callable:false,reasons:['not_assigned','outside_calling_window','dnc_registry_match']};
 f.values.status={...status,cadence:{...status.cadence,parked:true}};f.values.identities=[];
 await f.client.refresh();render(<CallingReadiness {...f.props}/>);fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));
 await screen.findByText(/not assigned to you/u);expect(screen.getByText(/outside this Firm’s calling hours/u)).toBeTruthy();expect(screen.getByText(/cadence is parked/u)).toBeTruthy();expect(screen.getByText(/Choose a current calling number/u)).toBeTruthy();expect(screen.getByText(/matches the National DNC registry/u)).toBeTruthy();expect(screen.queryByText(/checked clear/u)).toBeNull();
});
it.each(['route','identity','firm','version'] as const)('clears and fences a delayed response after %s selection changes',async field=>{
 const f=fixture();await f.client.refresh();const finish=f.hold();const mounted=render(<CallingReadiness {...f.props}/>);fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));
 await waitFor(()=>expect(f.send.mock.calls.some(([url])=>String(url).endsWith('/dial/check'))).toBe(true));mounted.rerender(<CallingReadiness {...f.props} {...(field==='route'?{route:{...route,id:other}}:field==='identity'?{identityId:other}:field==='firm'?{firmId:other}:{route:{...route,version:2}})}/>);
 await act(async()=>{finish(Response.json({advice}));});expect(screen.queryByText(/Policy snapshot/u)).toBeNull();expect(screen.getByRole('button',{name:'Check call readiness'}).matches(':disabled')).toBe(false);
});
it('clears current content and fences a held response on authentication loss',async()=>{
 const f=fixture();await f.client.refresh();render(<CallingReadiness {...f.props}/>);fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));await screen.findByText(/Policy snapshot/u);
 const finish=f.hold();fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));act(()=>f.client.invalidate());await act(async()=>{finish(Response.json({advice}));});expect(screen.queryByText(/Policy snapshot/u)).toBeNull();expect(screen.queryByText(/selected calling identity is currently available/u)).toBeNull();
});
it('refuses route mismatch or a failed read instead of retaining a previous snapshot',async()=>{
 const f=fixture();await f.client.refresh();render(<CallingReadiness {...f.props}/>);fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));await screen.findByText(/Policy snapshot/u);
 f.values.advice={...advice,e164:'+14015550188'};fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));await screen.findByText(/checks unavailable or the recorded route changed/u);expect(screen.queryByText(/Policy snapshot/u)).toBeNull();
 f.values.status={privateError:'not a supported result'};fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));await screen.findByText(/checks unavailable or the recorded route changed/u);expect(screen.queryByText(/privateError/u)).toBeNull();
});
it('requires a recorded route and respects a paused or held execution',async()=>{
 const f=fixture();await f.client.refresh();const mounted=render(<CallingReadiness {...f.props} route={null}/>);expect(screen.getByRole('button',{name:'Check call readiness'}).matches(':disabled')).toBe(true);
 mounted.rerender(<CallingReadiness {...f.props} disabled/>);fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));expect(f.send).toHaveBeenCalledTimes(1);
});

it('rejects remote route-version drift even when its ID and number are unchanged',async()=>{
 const f=fixture();await f.client.refresh();render(<CallingReadiness {...f.props}/>);
 fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));await screen.findByText(/Policy snapshot/u);
 f.values.routeVersion=2;fireEvent.click(screen.getByRole('button',{name:'Check call readiness'}));
 await screen.findByText(/checks unavailable or the recorded route changed/u);expect(screen.queryByText(/Policy snapshot/u)).toBeNull();
});
