import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {createElement} from 'react';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from '../../api/test/support/authFixture.ts';
import {issueSessionFor} from '../../api/test/support/sessionFixture.ts';
import {dispatch} from '../../api/src/server.ts';
import type {BookingPolicyRuntime} from '@fss/domain/meetings/bookingPolicyTypes.ts';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';
import type {OperationApi,OperationOutput} from '../src/shared/operations.ts';
import {createBookingPolicySettingsPorts} from '../src/renderer/settings/bookingPolicySettingsPorts.ts';
import {BookingPolicySettings} from '../src/renderer/settings/BookingPolicySettings.tsx';
import {bookingBindings} from './support/bookingPolicyFixture.ts';
import {readCurrentBookingPolicy,revalidateBookingPolicy} from '@fss/domain/meetings/bookingPolicy.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';

// Run with vitest.bookingPolicy.config.ts: this real-PG source journey is not an installed native acceptance test.
describe('mounted booking settings through authenticated operations and real PostgreSQL',()=>{
  let f:AuthFixture,api:OperationApi,setConfigurationAvailable:(available:boolean)=>void;
  beforeEach(async()=>{
    f=await createAuthFixture();
    const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken,bindings=bookingBindings(f.alpha.admin.userId);
    let configured=true;setConfigurationAvailable=available=>{configured=available;};
    const runtime:BookingPolicyRuntime={now:()=> '2026-10-13T21:00:00Z',readConfiguration:async()=>configured?[bindings]:[],readEvidence:async(_ctx,binding)=>({evidenceKind:'controlled',binding,verifiedAt:'2026-10-13T19:00:00Z',validUntil:'2026-10-14T19:00:00Z',accountAccess:true,calendarFreeBusy:true,eventSettings:true,modelConsent:true,modelAcceptance:true,senderAuthority:true,sourceAuthority:true,providerAdapter:true,releaseReady:true,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})};
    const client=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:CURRENT_CLIENT_VERSION,accessToken:async()=>({token,generation:0}),send:async(url,init)=>{
      const parsed=new URL(url);
      const response=await dispatch({method:init.method,path:parsed.pathname,query:parsed.searchParams,headers:init.headers,body:init.body===undefined?undefined:JSON.parse(init.body) as unknown},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,bookingPolicyRuntime:runtime});
      return {status:response.status,body:response.body};
    }});
    const handlers=operationHandlers({api:client,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);
    api={read:async(name,input)=>await answerOperation(handlers,'read',name,input) as OperationOutput<typeof name>,command:async(name,input)=>await answerOperation(handlers,'command',name,input) as OperationOutput<typeof name>};
  });
  afterEach(async()=>{cleanup();await f.stop();});
  it('owner selects exact configured scope, explicitly approves it and reads back saved-but-not-enabled policy',async()=>{
    render(createElement(BookingPolicySettings,{ports:createBookingPolicySettingsPorts(api),mayMutate:true}));
    const save=await screen.findByRole('button',{name:'Save booking policy'});
    fireEvent.click(screen.getByRole('checkbox',{name:/I approve this exact booking-only scope/}));
    fireEvent.click(save);
    expect(await screen.findByText('Saved policy: saved · revision 1')).toBeTruthy();
    expect(screen.getByText('Enabled: no')).toBeTruthy();
    expect(screen.getByText(/Controlled technical checks only/)).toBeTruthy();
    expect(screen.getByText(/20-minute introduction/)).toBeTruthy();
    expect(screen.getByText(/No call-count cap/)).toBeTruthy();
  });
  it('owner can revise a saved policy to lower ceilings while current setup is unavailable',async()=>{
    render(createElement(BookingPolicySettings,{ports:createBookingPolicySettingsPorts(api),mayMutate:true}));
    await screen.findByRole('button',{name:'Save booking policy'});
    fireEvent.click(screen.getByRole('checkbox',{name:/I approve this exact booking-only scope/}));
    fireEvent.click(screen.getByRole('button',{name:'Save booking policy'}));
    await screen.findByText('Saved policy: saved · revision 1');
    setConfigurationAvailable(false);
    fireEvent.click(screen.getByRole('button',{name:'Refresh booking policy'}));
    await screen.findByText(/Existing account, event, calendar and model setup is unavailable/);
    fireEvent.change(screen.getByLabelText('Daily booking ceiling (USD)'),{target:{value:'1.25'}});
    fireEvent.change(screen.getByLabelText('Monthly booking ceiling (USD)'),{target:{value:'20.00'}});
    fireEvent.click(screen.getByRole('checkbox',{name:/I approve this exact booking-only scope/}));
    fireEvent.click(screen.getByRole('button',{name:'Save booking policy'}));
    expect(await screen.findByText('Saved policy: saved · revision 2')).toBeTruthy();
    expect(screen.getByText(/Booking-only ceiling: \$1.25\/New York day and \$20.00/)).toBeTruthy();
    expect(screen.getByText('Enabled: no')).toBeTruthy();
  });
  it('owner disables the saved policy normally even when configured setup is unavailable',async()=>{
    render(createElement(BookingPolicySettings,{ports:createBookingPolicySettingsPorts(api),mayMutate:true}));
    await screen.findByRole('button',{name:'Save booking policy'});
    fireEvent.click(screen.getByRole('checkbox',{name:/I approve this exact booking-only scope/}));
    fireEvent.click(screen.getByRole('button',{name:'Save booking policy'}));
    await screen.findByText('Saved policy: saved · revision 1');
    setConfigurationAvailable(false);
    fireEvent.click(screen.getByRole('button',{name:'Refresh booking policy'}));
    await screen.findByText(/Existing account, event, calendar and model setup is unavailable/);
    fireEvent.click(screen.getByRole('button',{name:'Disable booking policy'}));
    expect(await screen.findByText('Saved policy: disabled · revision 2')).toBeTruthy();
    expect(screen.getByText('Enabled: no')).toBeTruthy();
  });
  it('normal UI revoke invalidates a genuinely current pending revision after fresh runtime construction',async()=>{
    render(createElement(BookingPolicySettings,{ports:createBookingPolicySettingsPorts(api),mayMutate:true}));
    await screen.findByRole('button',{name:'Save booking policy'});
    fireEvent.click(screen.getByRole('checkbox',{name:/I approve this exact booking-only scope/}));
    fireEvent.click(screen.getByRole('button',{name:'Save booking policy'}));
    await screen.findByText('Saved policy: saved · revision 1');
    const scope=workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'});
    const candidate=await readCurrentBookingPolicy(repositoryContext(scope,f.db),{ownerUserId:f.alpha.admin.userId});
    expect(candidate.kind).toBe('available');
    if(candidate.kind!=='available')throw new Error('current saved candidate missing');
    fireEvent.click(screen.getByRole('button',{name:'Revoke booking policy'}));
    expect(await screen.findByText('Saved policy: revoked · revision 2')).toBeTruthy();
    const restarted=repositoryContext(scope,await f.database.appRuntimeSession());
    expect(await revalidateBookingPolicy(restarted,candidate.snapshot)).toEqual({kind:'unavailable',reason:'policy_revoked'});
    expect(screen.getByText(/does not undo accepted bookings or cancel unrelated meetings/)).toBeTruthy();
  });
});
