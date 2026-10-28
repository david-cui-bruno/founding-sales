// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {CallingPreparationRead,CallingPreparationSelection} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingPreparation} from '../../src/client/CallingPreparation.tsx';
import {CallingSaveRecovery} from '../../src/client/CallingSaveRecovery.tsx';
import {CALLING_PREPARATION_PENDING_KEY} from '../../src/client/CallingPreparationCustody.ts';
import {browserApiPathAllowed} from '../../src/shared/browserContract.ts';
import {callingPreparationBrowserResult} from '../../src/server/callingPreparationBoundary.ts';
const id='00000000-0000-4000-8000-000000000001',firm='00000000-0000-4000-8000-000000000002';
const selection:CallingPreparationSelection={candidateId:id,expectedCandidateRevision:1,choice:{runId:id,observationId:id,blockId:'office',start:14,end:28,labelStart:0,labelEnd:12,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64)}};
function available():CallingPreparationRead{return {state:'available',selection,phone:{value:'+14015550123',choice:selection.choice,sourceUrl:'https://synthetic.example/contact',retrievedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()},profile:{companyName:'Synthetic source company',website:'https://synthetic.example/',addressLine:null,locality:null,regionCode:null,postalCode:null,countryCode:null,timeZone:{kind:'unknown'}},binding:null,duplicates:{possibleDuplicateFirmIds:[],possibleDuplicateCount:0,nextAction:'review_preparation'},unknowns:['company_identity_unverified','residential_fit_unverified','office_address_unknown','phone_type_unverified','time_zone_unknown','decision_maker_unknown'],qualification:'unverified',contactAuthority:'not_granted',fieldOwnership:'source_bound',researchPolicy:'required_before_enqueue'};}
const clients:BrowserClient[]=[];
function fixture(){
 const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()};
 const values:{view:CallingPreparationRead;receipt:unknown;lost:boolean;refusal:string|null;wait:Promise<Response>|null;confirmWait:Promise<Response>|null}={view:available(),receipt:{state:'unknown'},lost:false,refusal:null,wait:null,confirmWait:null};
 const writes:Record<string,unknown>[]=[],lookups:unknown[]=[],paths:string[]=[];
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  const path=String(url);paths.push(path);if(path==='/browser/session')return Response.json(session);
  if(path.endsWith('/calling/preparation/read'))return values.wait??Response.json(values.view);
  if(path.endsWith('/calling/preparation/receipt')){lookups.push(JSON.parse(String(init?.body)));return Response.json(values.receipt);}
  if(path.endsWith('/calling/preparation/confirm')){
   const input=JSON.parse(String(init?.body)) as Record<string,unknown>;writes.push(input);expect(localStorage.getItem(CALLING_PREPARATION_PENDING_KEY)).not.toBeNull();
   if(values.confirmWait)return values.confirmWait;
   if(values.lost)throw Error('Response lost');
   if(values.refusal)return Response.json(callingPreparationBrowserResult('/calling/preparation/confirm',409,{status:'refused',replayed:false,reason:values.refusal})!.body);
   if(values.view.state!=='available')throw Error('No preview');
   values.view={...values.view,profile:{...values.view.profile,countryCode:'US'},binding:{preparationId:id,revision:1,firmId:firm,routeId:id,routeVersion:1},researchPolicy:'paused_before_enqueue'};
   return Response.json({status:'accepted',replayed:false,result:{preparationId:id,revision:1,firmId:firm,routeId:id,historicalState:'prepared'}});
  }
  throw Error('Unexpected provider, acquisition or API route');
 });
 const client=new BrowserClient({fetch:fetcher,storage:localStorage,navigate:vi.fn(),randomUUID:()=>id});clients.push(client);return {client,values,writes,lookups,paths,session};
}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async(_name:string,_options:unknown,work:()=>Promise<unknown>)=>work())}});});
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());localStorage.clear();vi.unstubAllGlobals();});
async function mount(f=fixture()){
 await f.client.refresh();const open=vi.fn(),view=render(<CallingPreparation client={f.client} selection={selection} onOpenFirm={open}/>);
 return {...f,open,view};
}
async function review(){fireEvent.click(screen.getByRole('button',{name:'Review company details'}));await screen.findByLabelText('Company name');}
function confirm(){fireEvent.click(screen.getByLabelText('I have reviewed that this office is in the United States.'));fireEvent.click(screen.getByLabelText(/Keep these unverified/u));fireEvent.click(screen.getByRole('button',{name:'Save company'}));}
it('closed browser transport permits only read/confirm/receipt POST and preserves custody/auth collisions as closed failures',()=>{
 for(const path of ['/calling/preparation/read','/calling/preparation/confirm','/calling/preparation/receipt']){expect(browserApiPathAllowed('POST',path)).toBe(true);expect(browserApiPathAllowed('GET',path)).toBe(false);expect(browserApiPathAllowed('POST',path+'/extra')).toBe(false);}
 expect(browserApiPathAllowed('POST','/calling/preparation/rebind')).toBe(false);
 expect(callingPreparationBrowserResult('/calling/preparation/confirm',409,{status:'refused',replayed:false,reason:'command_payload_mismatch'})).toBeNull();
 const expired=available();if(expired.state==='available')expired.phone.expiresAt=new Date(Date.now()-1).toISOString();
 expect(callingPreparationBrowserResult('/calling/preparation/read',200,expired)).toEqual({status:409,body:{error:'browser_request_refused'}});
});
it('requires deliberate current review, US and ownership acknowledgement, then fresh read and explicit open without a call',async()=>{
 const f=await mount();expect(f.paths).toEqual(['/browser/session']);await review();expect(screen.getByRole('button',{name:'Save company'}).matches(':disabled')).toBe(true);
 expect(screen.getByLabelText('City · optional').getAttribute('value')).toBe('');confirm();
 await screen.findByRole('button',{name:'Open company'});expect(f.writes).toHaveLength(1);expect(f.open).not.toHaveBeenCalled();
 expect(f.writes[0]).not.toHaveProperty('phone');expect(f.writes[0]).not.toHaveProperty('researchAlreadyQualified');
 fireEvent.click(screen.getByRole('button',{name:'Open company'}));await waitFor(()=>expect(f.open).toHaveBeenCalledWith(firm,'Synthetic source company'));
 expect(f.paths.every(path=>path==='/browser/session'||path.startsWith('/browser/api/calling/preparation/'))).toBe(true);
});
it('response loss persists only original opaque custody; reload and UNKNOWN receipt never remint, replay or claim current acceptance',async()=>{
 const first=await mount();first.values.lost=true;await review();confirm();await screen.findByRole('button',{name:'Check save status'});
 const bytes=localStorage.getItem(CALLING_PREPARATION_PENDING_KEY)!;expect(bytes).not.toContain('Synthetic');expect(bytes).not.toContain('https:');expect(bytes).not.toContain('+1401');expect(bytes).not.toContain('reviewedProfile');
 const original=first.writes[0]!['commandId'];first.view.unmount();first.client.dispose();
 const next=fixture();next.session.revision='reauthenticated';const second=await mount(next);await screen.findByRole('button',{name:'Check save status'});
 fireEvent.click(screen.getByRole('button',{name:'Check save status'}));await waitFor(()=>expect(second.lookups).toHaveLength(1));
 expect(second.lookups[0]).toMatchObject({commandId:original});expect(second.writes).toEqual([]);expect(localStorage.getItem(CALLING_PREPARATION_PENDING_KEY)).toBe(bytes);
 second.values.receipt={state:'accepted',result:{preparationId:id,revision:1,firmId:firm,routeId:id,historicalState:'prepared'}};
 second.values.view={state:'withdrawn',preparationId:id,revision:2,reason:'source_withdrawn'};
 await waitFor(()=>expect(screen.getByRole('button',{name:'Check save status'}).matches(':disabled')).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Check save status'}));
 await screen.findByText(/Saved company details withdrawn/u);expect(screen.queryByRole('button',{name:'Open company'})).toBeNull();expect(second.writes).toEqual([]);
});
it('known duplicate and source refusal do not manufacture a Firm, and invalidated in-flight view publishes no source profile',async()=>{
 const f=await mount();const v=f.values.view;if(v.state!=='available')throw Error('fixture');v.duplicates={possibleDuplicateFirmIds:[firm],possibleDuplicateCount:1,nextAction:'select_recorded_company'};await review();expect(screen.getByRole('button',{name:'Save company'}).matches(':disabled')).toBe(true);expect(f.writes).toEqual([]);
 let resolve!:(response:Response)=>void;f.values.wait=new Promise(yes=>{resolve=yes;});fireEvent.click(screen.getByRole('button',{name:'Review company details'}));await waitFor(()=>expect(f.paths.filter(p=>p.endsWith('/read'))).toHaveLength(2));f.client.invalidate();resolve(Response.json(available()));await waitFor(()=>expect(screen.queryByLabelText('Company name')).toBeNull());
});
it('pending A→B→A reads release the new selection and cannot publish a late old A response or clear a newer busy operation',async()=>{
 const f=await mount();let oldA!:(response:Response)=>void,newA!:(response:Response)=>void;
 f.values.wait=new Promise(yes=>{oldA=yes;});fireEvent.click(screen.getByRole('button',{name:'Review company details'}));await waitFor(()=>expect(f.paths.filter(p=>p.endsWith('/read'))).toHaveLength(1));
 const second={...selection,candidateId:firm},secondView=available();if(secondView.state!=='available')throw Error('fixture');secondView.selection=second;secondView.profile.companyName='Second current company';f.values.wait=null;f.values.view=secondView;
 f.view.rerender(<CallingPreparation client={f.client} selection={second} onOpenFirm={f.open}/>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Review company details'}).matches(':disabled')).toBe(false));await review();expect((screen.getByLabelText('Company name') as HTMLInputElement).value).toBe('Second current company');
 f.view.rerender(<CallingPreparation client={f.client} selection={selection} onOpenFirm={f.open}/>);f.values.wait=new Promise(yes=>{newA=yes;});fireEvent.click(screen.getByRole('button',{name:'Review company details'}));await waitFor(()=>expect(f.paths.filter(p=>p.endsWith('/read'))).toHaveLength(3));
 const stale=available();if(stale.state!=='available')throw Error('fixture');stale.profile.companyName='Old A response';oldA(Response.json(stale));
 await waitFor(()=>expect(screen.queryByLabelText('Company name')).toBeNull());expect(screen.getByRole('button',{name:'Review company details'}).matches(':disabled')).toBe(true);
 const fresh=available();if(fresh.state!=='available')throw Error('fixture');fresh.profile.companyName='Current A response';newA(Response.json(fresh));
 await screen.findByDisplayValue('Current A response');expect(screen.queryByDisplayValue('Old A response')).toBeNull();expect(screen.getByRole('button',{name:'Review company details'}).matches(':disabled')).toBe(false);
});
it('loss followed by unavailable original phone/source and reload retains an accessible selection-independent original save status',async()=>{
 const first=await mount();first.values.lost=true;await review();confirm();await screen.findByRole('button',{name:'Check save status'});const original=first.writes[0]!['commandId'];first.view.unmount();first.client.dispose();
 const next=fixture();next.values.view={state:'withdrawn',preparationId:id,revision:2,reason:'source_withdrawn'};next.values.receipt={state:'accepted',result:{preparationId:id,revision:1,firmId:firm,routeId:id,historicalState:'prepared'}};
 await next.client.refresh();render(<CallingSaveRecovery client={next.client}/>);fireEvent.click(await screen.findByRole('button',{name:'Check save status'}));
 await screen.findByText(/The original company save was recorded/u);expect(next.lookups[0]).toMatchObject({commandId:original});expect(next.writes).toEqual([]);expect(next.paths.some(path=>path.endsWith('/read'))).toBe(false);expect(screen.queryByRole('button',{name:'Open company'})).toBeNull();expect(screen.queryByLabelText('Company name')).toBeNull();
});

it('a dispatched A save survives A→B→A and a late response as original UNKNOWN; mounted source-gone status recovers only history without reading B',async()=>{
 const f=await mount();let resolve!:(response:Response)=>void;f.values.confirmWait=new Promise(yes=>{resolve=yes;});await review();confirm();await waitFor(()=>expect(f.writes).toHaveLength(1));const original=f.writes[0]!['commandId'];
 const second={...selection,candidateId:firm};
 f.view.rerender(<><CallingSaveRecovery client={f.client} localCandidateId={firm}/><CallingPreparation client={f.client} selection={second} onOpenFirm={f.open}/></>);
 await screen.findByText(/Another company's save is unresolved/u);
 expect(screen.getAllByRole('button',{name:'Check save status'})).toHaveLength(1);
 f.view.rerender(<><CallingSaveRecovery client={f.client} localCandidateId={id}/><CallingPreparation client={f.client} selection={selection} onOpenFirm={f.open}/></>);
 await screen.findByText(/A company save is pending or UNKNOWN/u);
 resolve(Response.json({status:'accepted',replayed:false,result:{preparationId:id,revision:1,firmId:firm,routeId:id,historicalState:'prepared'}}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Check save status'}).matches(':disabled')).toBe(false));expect(localStorage.getItem(CALLING_PREPARATION_PENDING_KEY)).toContain(String(original));expect(f.open).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'Open company'})).toBeNull();
 // Current phone disappears while the same global recovery component stays mounted.
 f.view.rerender(<CallingSaveRecovery client={f.client}/>);f.values.receipt={state:'accepted',result:{preparationId:id,revision:1,firmId:firm,routeId:id,historicalState:'prepared'}};
 fireEvent.click(await screen.findByRole('button',{name:'Check save status'}));await screen.findByText(/The original company save was recorded/u);
 expect(f.lookups[0]).toMatchObject({commandId:original});expect(f.writes).toHaveLength(1);expect(f.paths.filter(path=>path.endsWith('/read'))).toHaveLength(1);expect(f.open).not.toHaveBeenCalled();
});
