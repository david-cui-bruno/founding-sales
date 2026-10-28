// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {CallingSetup as Setup} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingSetup} from '../../src/client/CallingSetup.tsx';
import {CALLING_SETUP_PENDING_KEY,CallingSetupCustody,installCallingSetupCustody} from '../../src/client/CallingSetupCustody.ts';
import {callingSetupBrowserResult} from '../../src/server/callingSetupBoundary.ts';
const id='00000000-0000-4000-8000-000000000001';
const clients:BrowserClient[]=[];
function fixture(shared=localStorage){
 const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()};
 const values:{snapshot:Setup;receipt:unknown;loss:boolean;refusal:string|null;readWait:Promise<Response>|null;writeWait:Promise<Response>|null}={snapshot:{callingProvider:{provider:'tel',version:0},telephonyBudget:{dailyCeilingCents:500,maxMinutesPerCall:4,unitPriceMicros:14000,version:3},spentTodayCents:25,configured:true},receipt:{state:'unknown'},loss:false,refusal:null,readWait:null,writeWait:null};
 const writes:Record<string,unknown>[]=[],receipts:unknown[]=[],paths:string[]=[];
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  const path=String(url);paths.push(path);
  if(path==='/browser/session')return Response.json(session);
  if(path==='/browser/api/calling/setup')return values.readWait??Response.json(values.snapshot);
  if(path==='/browser/api/calling/setup/receipt'||path==='/browser/api/calling/setup/budget-receipt'){receipts.push(JSON.parse(String(init?.body)));return Response.json(values.receipt);}
  if(path==='/browser/api/calling/setup/provider'||path==='/browser/api/calling/setup/budget'){
   const input=JSON.parse(String(init?.body)) as Record<string,unknown>;writes.push(input);expect(shared.getItem(CALLING_SETUP_PENDING_KEY)).not.toBeNull();
   if(values.writeWait)return values.writeWait;
   if(values.loss)throw Error('Response lost');
   if(values.refusal){const mapped=callingSetupBrowserResult('/calling/setup/provider',409,{status:'refused',replayed:false,reason:values.refusal});return Response.json(mapped?.body??{error:'refused'},{status:mapped?.status??409});}
   const budget=path.endsWith('/budget');
   values.snapshot=budget?{...values.snapshot,telephonyBudget:{...values.snapshot.telephonyBudget,dailyCeilingCents:Number(input['dailyCeilingCents']),version:Number(input['expectedVersion'])+1}}:{...values.snapshot,callingProvider:{provider:input['provider'] as 'tel'|'twilio',version:Number(input['expectedVersion'])+1}};
   return Response.json({status:'accepted',replayed:false,result:budget?{dailyCeilingCents:values.snapshot.telephonyBudget.dailyCeilingCents,version:values.snapshot.telephonyBudget.version}:values.snapshot.callingProvider});
  }
  throw Error('Unapproved effect or route');
 });
 const client=new BrowserClient({fetch:fetcher,storage:shared,navigate:vi.fn(),randomUUID:()=>id});clients.push(client);const stop=installCallingSetupCustody(client,shared);
 return {client,values,writes,receipts,paths,session,stop,custody:new CallingSetupCustody(client,shared)};
}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async(_name:string,_options:unknown,work:()=>Promise<unknown>)=>work())}});});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();vi.unstubAllGlobals();});
async function mounted(f=fixture()){await f.client.refresh();const view=render(<CallingSetup client={f.client}/>);await screen.findByText(`$${(f.values.snapshot.telephonyBudget.dailyCeilingCents/100).toFixed(2)}`);await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh calling status'}).matches(':disabled')).toBe(false));return {...f,view};}
it('loads strict status before any selection and explicitly changes only provider under the shown version/cap',async()=>{
 const f=await mounted();expect(screen.getByText('Off')).toBeTruthy();expect(screen.getByText('$0.25')).toBeTruthy();expect(screen.getByText(/4 minutes at \$0.014 per minute/u)).toBeTruthy();expect(f.writes).toEqual([]);
 fireEvent.click(screen.getByRole('button',{name:'Enable browser calling'}));fireEvent.click(screen.getByRole('button',{name:'Enable browser calling'}));
 await screen.findByText('On · Twilio');expect(f.writes).toHaveLength(1);expect(f.writes[0]).toEqual({provider:'twilio',expectedVersion:0,commandId:expect.any(String)});
 expect(screen.getByText(/No call was started/u)).toBeTruthy();expect(f.custody.read()).toBeNull();
 expect(f.values.snapshot.telephonyBudget).toEqual({dailyCeilingCents:500,maxMinutesPerCall:4,unitPriceMicros:14000,version:3});
 expect(f.paths.every(p=>p==='/browser/session'||p.startsWith('/browser/api/calling/setup'))).toBe(true);
});
it.each(['provider','budget','price'] as const)('refuses Enable with absent %s without hiding current controls',async reason=>{
 const f=fixture();if(reason==='provider')f.values.snapshot.configured=false;else if(reason==='budget')f.values.snapshot.telephonyBudget.dailyCeilingCents=0;else f.values.snapshot.telephonyBudget.unitPriceMicros=0;
 await f.client.refresh();render(<CallingSetup client={f.client}/>);await screen.findByText('Off');expect(screen.getByRole('button',{name:'Enable browser calling'}).matches(':disabled')).toBe(true);expect(f.writes).toHaveLength(0);
});
it('allows explicit OFF despite unconfigured provider and disabled budget',async()=>{
 const f=fixture();f.values.snapshot={...f.values.snapshot,callingProvider:{provider:'twilio',version:8},configured:false,telephonyBudget:{...f.values.snapshot.telephonyBudget,dailyCeilingCents:0}};
 await f.client.refresh();render(<CallingSetup client={f.client}/>);await screen.findByText('On · Twilio');fireEvent.click(screen.getByRole('button',{name:'Turn off browser calling'}));await screen.findByText('Off');expect(f.writes).toEqual([{provider:'tel',expectedVersion:8,commandId:expect.any(String)}]);
});
it('salesperson sees status with no write action and no role/sign-in reset',async()=>{
 const f=fixture();f.session.role='salesperson';await f.client.refresh();render(<CallingSetup client={f.client}/>);await screen.findByText('$5.00');expect(screen.queryByRole('button',{name:'Enable browser calling'})).toBeNull();expect(screen.queryByRole('button',{name:'Turn off browser calling'})).toBeNull();expect(f.writes).toEqual([]);expect(f.client.current?.status).toBe('signed_in');
});
it.each(['setting_version_conflict','integration_unconfigured','telephony_budget_disabled'] as const)('receipted %s stays a product refusal, reads current status, and leaves identity intact',async reason=>{
 const f=await mounted();f.values.refusal=reason;
 fireEvent.click(screen.getByRole('button',{name:'Enable browser calling'}));await screen.findByText(reason==='setting_version_conflict'?/setting changed/u:reason==='integration_unconfigured'?/An operator must configure/u:/already approved, nonzero budget/u);
 expect(screen.getByText('Off')).toBeTruthy();expect(f.client.current?.status).toBe('signed_in');expect(f.custody.read()).toBeNull();expect(f.writes).toHaveLength(1);
});
it('response loss survives remount; UNKNOWN receipt cannot mint/replay, historical acceptance reads newer OFF',async()=>{
 const f=await mounted();f.values.loss=true;fireEvent.click(screen.getByRole('button',{name:'Enable browser calling'}));await screen.findByText(/This change is UNKNOWN/u);const held=f.custody.read()!;expect(held.commandId).toBeTruthy();
 f.view.unmount();render(<CallingSetup client={f.client}/>);await screen.findByText(/No replacement change is allowed/u);
 expect(screen.getByRole('button',{name:'Enable browser calling'}).matches(':disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Check original setup receipt'}));await screen.findByText(/This change is UNKNOWN/u);expect(f.custody.read()).toEqual(held);expect(f.writes).toHaveLength(1);
 f.values.receipt={state:'accepted',result:{provider:'twilio',version:1}};f.values.snapshot.callingProvider={provider:'tel',version:2};
 fireEvent.click(screen.getByRole('button',{name:'Check original setup receipt'}));await screen.findByText(/Change recorded/u);expect(screen.getByText('Off')).toBeTruthy();expect(screen.queryByText('On · Twilio')).toBeNull();expect(f.custody.read()).toBeNull();expect(f.receipts).toEqual([{commandId:held.commandId,payloadSHA256:held.payloadSHA256},{commandId:held.commandId,payloadSHA256:held.payloadSHA256}]);expect(f.writes).toHaveLength(1);
});
it('a second tab cannot replace the original UNKNOWN, and malformed custody fails closed',async()=>{
 const f=await mounted();f.values.loss=true;fireEvent.click(screen.getByRole('button',{name:'Enable browser calling'}));await screen.findByText(/This change is UNKNOWN/u);const held=f.custody.read()!;
 const second=fixture();await second.client.refresh();expect(await second.custody.change({expectedVersion:0,provider:'twilio'},()=>true)).toEqual({state:'unknown'});expect(second.writes).toHaveLength(0);expect(second.custody.read()).toEqual(held);
 localStorage.setItem(CALLING_SETUP_PENDING_KEY,'corrupt');await expect(second.custody.change({expectedVersion:0,provider:'twilio'},()=>true)).rejects.toThrow();expect(second.writes).toHaveLength(0);
});
it.each(['read','write'] as const)('late %s cannot publish after auth invalidation or reset authority',async kind=>{
 const f=await mounted();const priorReads=f.paths.filter(p=>p==='/browser/api/calling/setup').length;let resolve!:(response:Response)=>void;const wait=new Promise<Response>(yes=>{resolve=yes;});
 if(kind==='read'){f.values.readWait=wait;fireEvent.click(screen.getByRole('button',{name:'Refresh calling status'}));}else{f.values.writeWait=wait;fireEvent.click(screen.getByRole('button',{name:'Enable browser calling'}));}
 await waitFor(()=>expect(kind==='read'?f.paths.filter(p=>p==='/browser/api/calling/setup').length>priorReads:f.paths.includes('/browser/api/calling/setup/provider')).toBe(true));
 act(()=>f.client.invalidate());await act(async()=>{resolve(Response.json(kind==='read'?f.values.snapshot:{status:'accepted',replayed:false,result:{provider:'twilio',version:1}}));});
 expect(screen.queryByText('On · Twilio')).toBeNull();expect(screen.queryByText('$5.00')).toBeNull();expect(screen.queryByText(/Change recorded/u)).toBeNull();expect(f.client.current).toBeNull();
});
it('a delayed local Web Lock rechecks role/generation before persistence and dispatch',async()=>{
 const f=await mounted();let release!:()=>void;const barrier=new Promise<void>(yes=>{release=yes;});Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async(_name:string,_options:unknown,work:()=>Promise<unknown>)=>{await barrier;return work();})}});
 fireEvent.click(screen.getByRole('button',{name:'Enable browser calling'}));act(()=>f.client.invalidate());await act(async()=>{release();});expect(f.writes).toHaveLength(0);expect(f.client.current).toBeNull();expect(screen.queryByText('On · Twilio')).toBeNull();
});
it('saves the shown daily budget version without changing provider, rate or call duration',async()=>{
 const f=fixture();f.values.snapshot.telephonyBudget.dailyCeilingCents=100;await mounted(f);const previous=structuredClone(f.values.snapshot);
 fireEvent.change(screen.getByLabelText('Daily calling budget in dollars'),{target:{value:'5'}});fireEvent.click(screen.getByRole('button',{name:'Save daily calling budget'}));await screen.findByText('$5.00');
 expect(f.writes).toEqual([{dailyCeilingCents:500,expectedVersion:3,commandId:expect.any(String)}]);
 expect(f.values.snapshot).toEqual({...previous,telephonyBudget:{...previous.telephonyBudget,dailyCeilingCents:500,version:4}});expect(f.custody.read()).toBeNull();
});
it('lost budget response blocks provider changes and recovers only the original budget receipt',async()=>{
 const f=await mounted();f.values.loss=true;fireEvent.change(screen.getByLabelText('Daily calling budget in dollars'),{target:{value:'5.00'}});fireEvent.click(screen.getByRole('button',{name:'Save daily calling budget'}));await screen.findByText(/This change is UNKNOWN/u);const held=f.custody.read()!;
 expect(await f.custody.change({expectedVersion:0,provider:'twilio'},()=>true)).toEqual({state:'unknown'});expect(f.writes).toHaveLength(1);
 f.values.receipt={state:'accepted',result:{dailyCeilingCents:500,version:4}};f.values.snapshot.telephonyBudget={...f.values.snapshot.telephonyBudget,dailyCeilingCents:200,version:5};
 fireEvent.click(screen.getByRole('button',{name:'Check original setup receipt'}));await screen.findByText('$2.00');expect(f.paths).toContain('/browser/api/calling/setup/budget-receipt');expect(f.paths).not.toContain('/browser/api/calling/setup/receipt');
 expect(f.receipts).toEqual([{commandId:held.commandId,payloadSHA256:held.payloadSHA256}]);expect(f.custody.read()).toBeNull();expect(f.writes).toHaveLength(1);
});
