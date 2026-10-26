// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {useState} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {pluralFirmPageResponseSchema,type CallingWrapInput} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingExecutionCustody,CALLING_EXECUTION_KEY,installCallingExecutionCustody} from '../../src/client/CallingExecutionPending.ts';
import {CallingExecutionController,type CallingExecutionState,type CallingExecutionLink} from '../../src/client/CallingExecutionDispatch.ts';
import {CallingExecution} from '../../src/client/CallingExecution.tsx';
import {CallingWrap} from '../../src/client/CallingWrap.tsx';
import type {CallingContextData} from '../../src/client/CallingContext.tsx';
import type {CallingVoiceEvent} from '../../src/client/CallingVoiceDevice.ts';
const id='00000000-0000-4000-8000-000000000001',routeId='00000000-0000-4000-8000-000000000002',sessionId='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004';
const at='2026-10-26T00:00:00.000Z';
const firm={id,name:'Fictional execution Firm',website:null,locality:null,regionCode:null,status:'active',assignedUserId:id,stageKey:null,opportunityStatus:null,controlMode:null,openedAt:null,timeZone:null,timeZoneUnresolvedReason:null,addressLine:null,postalCode:null,countryCode:'US',timeZoneConfidence:null,timeZoneSource:null,contacts:[],phoneRoutes:[{id:routeId,contactId:null,value:'+12145550123',eligibility:'usable',version:1}],emailRoutes:[],aliases:[]};
const page={version:3,visibility:'assigned_or_admin',read:{visibility:'assigned_or_admin',firm},opportunities:[],holds:[],followUpPermissions:[]};
const context:CallingContextData={entry:{subject:{kind:'firm',firmId:id},label:firm.name},firm:pluralFirmPageResponseSchema.parse(page)};
const payload={firmId:id,routeId,routeVersion:1,callingIdentityId:id};
const identity={id,ownerUserId:id,e164:'+12145550124',label:null,verificationStatus:'verified',enabled:true,verifiedAt:at,verifiedByUserId:id,verificationMethod:'owner_attestation',disabledAt:null,usedForCalls:true,createdAt:at};
const clients:BrowserClient[]=[];
const states:CallingExecutionState[]=[];
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {resolve,promise};}
function locks(){const active=new Set<string>(),queues=new Map<string,Promise<unknown>>();return {request:async(name:string,options:{ifAvailable?:boolean},work:(lock:unknown)=>Promise<unknown>)=>{if(options.ifAvailable&&active.has(name))return work(null);const prior=queues.get(name)??Promise.resolve();const done=deferred<void>();queues.set(name,done.promise);await prior;active.add(name);try{return await work({name,mode:'exclusive'});}finally{active.delete(name);done.resolve();}}};}
function setup(){
 let lose=false,providerOff=false,changedRoute=false,status='completed',sessionWait:Promise<Response>|null=null;
 const requests:{path:string;body:unknown}[]=[],writes:CallingWrapInput[]=[];
 const send=vi.fn<typeof fetch>(async(url,init)=>{const path=String(url),body=init?.body?JSON.parse(String(init.body)) as unknown:undefined;requests.push({path,body});
  if(path==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+600000).toISOString()});
  if(path.endsWith('/firm-page-v3'))return Response.json(changedRoute?{...page,read:{...page.read,firm:{...firm,phoneRoutes:[{...firm.phoneRoutes[0],version:2}]}}}:page);
  if(path.endsWith('/calling-identities'))return Response.json({identities:[identity]});
  if(path.includes('/calls/calling?'))return Response.json(providerOff?{availability:'unavailable',reason:'calling_off'}:{provider:'twilio',cadence:{unansweredAttempts:0,nextAttempt:1,limit:4,parked:false,refusal:null},voicemailTemplate:'Neutral',callerName:'Fictional user',callbackNumber:null});
  if(path.endsWith('/calls/access-token'))return Response.json({token:'EPHEMERAL_TOKEN_NEVER_PERSIST',identity:id,expiresAt:new Date(Date.now()+600000).toISOString()});
  if(path.endsWith('/calls/session')){if(lose)throw Error('Response lost');if(sessionWait)return sessionWait;return Response.json({status:'accepted',replayed:false,result:{sessionId,expiresAt:new Date(Date.now()+60000).toISOString()}});}
  if(path.endsWith('/calling/execution/receipt'))return Response.json({state:'accepted',firmId:id,sessionId,expiresAt:new Date(Date.now()+60000).toISOString(),status,canReconnect:false});
  if(path.endsWith('/calling/wrap')){const input=body as CallingWrapInput;writes.push(input);return Response.json({status:'accepted',replayed:false,result:{kind:'firm',firmId:id,callLogId:other,staleIntroductions:'stopped',attention:[],followUp:input.promisedEmail?{state:'queued_for_review',draftId:input.promisedEmail.draftId,revision:1}:{state:'not_requested'}}});}
  if(path.endsWith('/calling/follow-ups/read')){const draft=writes[0]?.promisedEmail;if(!draft)throw Error('Missing draft');return Response.json({draft:{draftId:draft.draftId,revision:1,source:{kind:'firm',firmId:id,callLogId:other},availability:'available',createdAt:at,updatedAt:at,content:{subject:draft.subject,body:draft.body},state:'queued_for_review',recipient:'unresolved',sendAuthority:'not_granted'}});}
  throw Error(`Unexpected fake route ${path}`);
 });
 const client=new BrowserClient({fetch:send,storage:localStorage,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);installCallingExecutionCustody(client);
 const events=new Map<CallingVoiceEvent,(detail?:unknown)=>void>();
 const call={on:vi.fn((event:CallingVoiceEvent,listener:(detail?:unknown)=>void)=>{events.set(event,listener);}),mute:vi.fn(),disconnect:vi.fn()};
 const device={connect:vi.fn(async()=>call),destroy:vi.fn()},factory=vi.fn(async()=>device),microphone=vi.fn(async()=>{}),custody=new CallingExecutionCustody(client);
 const controller=new CallingExecutionController(custody,state=>states.push(state),{device:factory,microphone});
 return {client,controller,custody,requests,writes,call,device,factory,microphone,events,ports:{device:factory,microphone},lose:()=>{lose=true;},off:()=>{providerOff=true;},stale:()=>{changedRoute=true;},status:(value:string)=>{status=value;},wait:(value:Promise<Response>)=>{sessionWait=value;}};
}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:locks()});states.length=0;});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();vi.unstubAllGlobals();});
it('explicit start obtains mic first, fresh route/identity/token/session then connects once with only sessionId',async()=>{
 const f=setup();await f.client.refresh();expect(f.factory).not.toHaveBeenCalled();const live=f.controller.start(payload,()=>true);
 await waitFor(()=>expect(f.device.connect).toHaveBeenCalledWith({sessionId}));expect(f.microphone).toHaveBeenCalledTimes(1);expect(f.factory).toHaveBeenCalledTimes(1);
 expect(f.requests.filter(r=>r.path.includes('/browser/api/')).map(r=>r.path)).toEqual(['/browser/api/crm/firm-page-v3','/browser/api/calling-identities',`/browser/api/calls/calling?firmId=${id}`,'/browser/api/calls/access-token','/browser/api/calls/session']);
 expect(localStorage.getItem(CALLING_EXECUTION_KEY)).not.toMatch(/EPHEMERAL|1214555|Fictional/u);
 f.events.get('accept')?.();expect(states.at(-1)?.phase).toBe('connected');f.controller.mute();expect(f.call.mute).toHaveBeenCalledWith(true);
 f.controller.stop();await live;expect(states.at(-1)?.phase).toBe('unknown');expect(f.custody.read()?.sessionId).toBe(sessionId);
 f.status('in_progress');await f.controller.recover(()=>true);expect(f.custody.read()).not.toBeNull();expect(states.at(-1)?.link).toBeNull();
 f.status('completed');await f.controller.recover(()=>true);expect(f.custody.read()).toBeNull();expect(states.at(-1)?.link).toMatchObject({firmId:id,sessionId,routeId});expect(f.factory).toHaveBeenCalledTimes(1);
});
it('lost session response recovers exact UUID/hash with no replay or SDK connection',async()=>{
 const f=setup();await f.client.refresh();f.lose();await f.controller.start(payload,()=>true);const held=f.custody.read();expect(held).not.toBeNull();
 await f.controller.start({...payload,firmId:other},()=>true);expect(f.requests.filter(r=>r.path.endsWith('/calls/session'))).toHaveLength(1);
 await f.controller.recover(()=>true);expect(f.requests.find(r=>r.path.endsWith('/execution/receipt'))?.body).toEqual({firmId:id,commandId:held?.commandId,payloadSHA256:held?.payloadSHA256});expect(f.factory).not.toHaveBeenCalled();
});
it.each(['microphone','provider','stale route','missing locks','broken storage'])('fails closed before creating a session for %s',async kind=>{
 const f=setup();await f.client.refresh();if(kind==='microphone')f.microphone.mockRejectedValueOnce(Error('Denied'));if(kind==='provider')f.off();if(kind==='stale route')f.stale();if(kind==='missing locks')Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});if(kind==='broken storage')vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw Error('Unavailable');});
 await f.controller.start(payload,()=>true);expect(f.requests.filter(r=>r.path.endsWith('/calls/session'))).toHaveLength(0);expect(f.factory).not.toHaveBeenCalled();vi.restoreAllMocks();
});
it('cross-tab lifecycle exclusion prevents a second Firm while the first microphone prompt is pending',async()=>{
 const f=setup();await f.client.refresh();const mic=deferred<void>();f.microphone.mockImplementationOnce(()=>mic.promise);const first=f.controller.start(payload,()=>true);
 await waitFor(()=>expect(f.microphone).toHaveBeenCalledTimes(1));const otherTab=new CallingExecutionController(new CallingExecutionCustody(f.client),()=>{},f.ports);await otherTab.start({...payload,firmId:other},()=>true);expect(f.microphone).toHaveBeenCalledTimes(1);
 f.controller.stop();mic.resolve();await first;expect(f.factory).not.toHaveBeenCalled();expect(f.requests.filter(r=>r.path.endsWith('/calls/session'))).toHaveLength(0);
});
it('late session response after cancellation never connects and remains recoverable',async()=>{
 const f=setup();await f.client.refresh();const response=deferred<Response>();f.wait(response.promise);const first=f.controller.start(payload,()=>true);
 await waitFor(()=>expect(f.custody.read()).not.toBeNull());await waitFor(()=>expect(f.requests.some(r=>r.path.endsWith('/calls/session'))).toBe(true));f.controller.stop();response.resolve(Response.json({status:'accepted',replayed:false,result:{sessionId,expiresAt:new Date(Date.now()+60000).toISOString()}}));await first;
 expect(f.factory).not.toHaveBeenCalled();expect(f.custody.read()).not.toBeNull();await f.controller.recover(()=>true);expect(f.custody.read()).toBeNull();
});
it('auth loss clears opaque custody and late SDK setup cannot resurrect audio',async()=>{
 const f=setup();await f.client.refresh();const device=deferred<typeof f.device>();f.factory.mockImplementationOnce(()=>device.promise);const live=f.controller.start(payload,()=>true);await waitFor(()=>expect(f.factory).toHaveBeenCalledTimes(1));f.client.invalidate();f.controller.dispose();device.resolve(f.device);await live;
 expect(f.device.connect).not.toHaveBeenCalled();expect(f.device.destroy).toHaveBeenCalled();await waitFor(()=>expect(JSON.parse(localStorage.getItem(CALLING_EXECUTION_KEY)??'[]')).toEqual([]));
});
it('source/navigation change disconnects a late SDK call and preserves opaque session custody',async()=>{
 const f=setup();await f.client.refresh();const connecting=deferred<typeof f.call>();f.device.connect.mockImplementationOnce(()=>connecting.promise);let current=true;const live=f.controller.start(payload,()=>current);await waitFor(()=>expect(f.device.connect).toHaveBeenCalledTimes(1));current=false;f.controller.dispose();connecting.resolve(f.call);await live;
 expect(f.call.disconnect).toHaveBeenCalledTimes(1);expect(f.device.destroy).toHaveBeenCalled();expect(f.custody.read()?.sessionId).toBe(sessionId);
 const reloaded=new CallingExecutionController(new CallingExecutionCustody(f.client),state=>states.push(state),f.ports);await reloaded.recover(()=>true);expect(f.custody.read()).toBeNull();expect(f.factory).toHaveBeenCalledTimes(1);expect(f.requests.filter(r=>r.path.endsWith('/calls/session'))).toHaveLength(1);
});
it('server expired_unconsumed ends uncertainty without fabricating a call/session wrap link',async()=>{
 const f=setup();await f.client.refresh();f.lose();await f.controller.start(payload,()=>true);f.status('expired_unconsumed');await f.controller.recover(()=>true);expect(f.custody.read()).toBeNull();expect(states.at(-1)?.link).toBeNull();expect(f.factory).not.toHaveBeenCalled();
});
it('unavailable receipt never permits a replacement UUID or reconnect',async()=>{
 const f=setup();await f.client.refresh();f.lose();await f.controller.start(payload,()=>true);const held=f.custody.read();f.status('unavailable');await f.controller.recover(()=>true);expect(f.custody.read()).toEqual(held);await f.controller.start(payload,()=>true);expect(f.custody.read()).toEqual(held);expect(f.factory).not.toHaveBeenCalled();expect(f.requests.filter(r=>r.path.endsWith('/calls/session'))).toHaveLength(1);
});
it('mounted execution requires recording attestation and passes only terminal exact session to explicit promised wrap',async()=>{
 const f=setup();await f.client.refresh();function View(){const [blocked,setBlocked]=useState(false),[link,setLink]=useState<CallingExecutionLink|null>(null);return <><CallingExecution client={f.client} context={context} paused={false} isScopeCurrent={()=>true} onBlockedChange={setBlocked} onLinkChange={setLink} ports={f.ports}/><CallingWrap client={f.client} subject={{kind:'firm',firmId:id}} context={context} paused={blocked} executionLink={link} onPendingChange={()=>{}}/></>;}
 render(<View/>);await screen.findByRole('option',{name:identity.e164});expect(f.factory).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Call in browser'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('Browser call route'),{target:{value:routeId}});fireEvent.click(screen.getByRole('checkbox',{name:/authorized to place and record/u}));fireEvent.click(screen.getByRole('button',{name:'Call in browser'}));await waitFor(()=>expect(f.device.connect).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('button',{name:'Hang up / abandon setup'}));await screen.findByRole('button',{name:'Check exact call receipt'});fireEvent.click(screen.getByRole('button',{name:'Check exact call receipt'}));await screen.findByText(/Linked to the exact server-terminated/u);
 fireEvent.change(screen.getByLabelText('Actual outcome'),{target:{value:'interested'}});fireEvent.change(screen.getByLabelText('Private call notes'),{target:{value:'PRIVATE context not email'}});fireEvent.click(screen.getByRole('checkbox',{name:/personally performed/u}));fireEvent.change(screen.getByLabelText('Next action'),{target:{value:'promised_email'}});fireEvent.change(screen.getByLabelText('Promised email subject'),{target:{value:'Independent promise'}});fireEvent.change(screen.getByLabelText('Promised email body'),{target:{value:'Independent editable body'}});fireEvent.click(screen.getByRole('button',{name:'Save outcome and promised email'}));await screen.findByRole('article',{name:'Recorded calling outcome'});
 expect(f.writes[0]).toMatchObject({kind:'firm',firmId:id,report:{callSessionId:sessionId,routeId,outcome:'interested'},promisedEmail:{subject:'Independent promise',body:'Independent editable body'}});expect(JSON.stringify(f.writes[0]?.promisedEmail)).not.toContain('PRIVATE');expect(f.factory).toHaveBeenCalledTimes(1);
});
