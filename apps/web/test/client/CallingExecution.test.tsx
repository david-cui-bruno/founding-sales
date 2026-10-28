// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import type {EventEmitter} from 'node:events';
import {useState} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {pluralFirmPageResponseSchema,type CallingWrapInput} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingExecutionCustody,CALLING_EXECUTION_KEY,installCallingExecutionCustody} from '../../src/client/CallingExecutionPending.ts';
import {CallingExecutionController,type CallingExecutionState,type CallingExecutionLink} from '../../src/client/CallingExecutionDispatch.ts';
import {CallingExecution} from '../../src/client/CallingExecution.tsx';
import {CallingAudioTest} from '../../src/client/CallingAudioTest.tsx';
import {CallingWrap} from '../../src/client/CallingWrap.tsx';
import type {CallingContextData} from '../../src/client/CallingContext.tsx';
import {browserCallingVoiceDevice,type CallingVoiceCall,type CallingVoiceEvent} from '../../src/client/CallingVoiceDevice.ts';
const sdk=vi.hoisted(()=>({instances:[] as (EventEmitter&{destroy:ReturnType<typeof vi.fn>})[],connect:vi.fn<()=>Promise<CallingVoiceCall>>()}));
vi.mock('@twilio/voice-sdk',async()=>{const {EventEmitter}=await import('node:events');return {Device:class extends EventEmitter{constructor(){super();sdk.instances.push(this);}connect(){return sdk.connect();}destroy=vi.fn();}};});
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
  if(path.endsWith('/calling/setup'))return Response.json({callingProvider:{provider:providerOff?'tel':'twilio',version:1},telephonyBudget:{dailyCeilingCents:500,maxMinutesPerCall:30,unitPriceMicros:14000,version:2},spentTodayCents:0,configured:true});
  if(path.includes('/calls/calling?'))return Response.json(providerOff?{availability:'unavailable',reason:'calling_off'}:{provider:'twilio',cadence:{unansweredAttempts:0,nextAttempt:1,limit:4,parked:false,refusal:null},voicemailTemplate:'Neutral',callerName:'Fictional user',callbackNumber:null});
  if(path.endsWith('/calls/access-token'))return Response.json({token:'EPHEMERAL_TOKEN_NEVER_PERSIST',identity:id,expiresAt:new Date(Date.now()+600000).toISOString()});
  if(path.endsWith('/calls/session')||path.endsWith('/calling/audio-test/session')){if(lose)throw Error('Response lost');if(sessionWait)return sessionWait;return Response.json({status:'accepted',replayed:false,result:{sessionId,expiresAt:new Date(Date.now()+60000).toISOString()}});}
  if(path.endsWith('/calling/audio-test/receipt'))return Response.json({state:'accepted',sessionId,expiresAt:new Date(Date.now()+60000).toISOString(),status,canReconnect:false});
  if(path.endsWith('/calling/execution/receipt'))return Response.json({state:'accepted',firmId:id,sessionId,expiresAt:new Date(Date.now()+60000).toISOString(),status,canReconnect:false});
  if(path.endsWith('/calling/wrap')){const input=body as CallingWrapInput;writes.push(input);return Response.json({status:'accepted',replayed:false,result:{kind:'firm',firmId:id,callLogId:other,staleIntroductions:'stopped',attention:[],followUp:input.promisedEmail?{state:'queued_for_review',draftId:input.promisedEmail.draftId,revision:1}:{state:'not_requested'}}});}
  if(path.endsWith('/calling/follow-ups/read')){const draft=writes[0]?.promisedEmail;if(!draft)throw Error('Missing draft');return Response.json({draft:{draftId:draft.draftId,revision:1,source:{kind:'firm',firmId:id,callLogId:other},availability:'available',createdAt:at,updatedAt:at,content:{subject:draft.subject,body:draft.body},state:'queued_for_review',recipient:'unresolved',sendAuthority:'not_granted'}});}
  throw Error(`Unexpected fake route ${path}`);
 });
 const client=new BrowserClient({fetch:send,storage:localStorage,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);installCallingExecutionCustody(client);
 const events=new Map<CallingVoiceEvent,(detail?:unknown)=>void>();
 const call={on:vi.fn((event:CallingVoiceEvent,listener:(detail?:unknown)=>void)=>{events.set(event,listener);}),mute:vi.fn(),disconnect:vi.fn()};
 const device={onError:vi.fn((_listener:()=>void)=>()=>{}),connect:vi.fn(async()=>call),destroy:vi.fn()},factory=vi.fn(async()=>device),microphone=vi.fn(async()=>{}),custody=new CallingExecutionCustody(client);
 const controller=new CallingExecutionController(custody,state=>states.push(state),{device:factory,microphone});
 return {client,controller,custody,requests,writes,call,device,factory,microphone,events,ports:{device:factory,microphone},lose:()=>{lose=true;},off:()=>{providerOff=true;},stale:()=>{changedRoute=true;},status:(value:string)=>{status=value;},wait:(value:Promise<Response>)=>{sessionWait=value;}};
}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:locks()});states.length=0;sdk.instances.length=0;sdk.connect.mockReset();});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();vi.unstubAllGlobals();});
it('explicit start obtains mic first, fresh route/identity/token/session then connects once with only sessionId',async()=>{
 const f=setup();await f.client.refresh();expect(f.factory).not.toHaveBeenCalled();const live=f.controller.start(payload,()=>true);
 await waitFor(()=>expect(f.device.connect).toHaveBeenCalledWith({sessionId}));expect(f.microphone).toHaveBeenCalledTimes(1);expect(f.factory).toHaveBeenCalledTimes(1);
 expect(f.requests.filter(r=>r.path.includes('/browser/api/')).map(r=>r.path)).toEqual(['/browser/api/crm/firm-page-v3','/browser/api/calling-identities',`/browser/api/calls/calling?firmId=${id}`,'/browser/api/calls/access-token','/browser/api/calls/session']);
 expect(localStorage.getItem(CALLING_EXECUTION_KEY)).not.toMatch(/EPHEMERAL|1214555|Fictional/u);
 f.events.get('accept')?.();expect(states.at(-1)?.phase).toBe('connected');f.controller.mute();expect(f.call.mute).toHaveBeenCalledWith(true);
 f.controller.stop();await live;expect(states.at(-1)?.phase).toBe('unknown');expect(f.custody.read()?.sessionId).toBe(sessionId);
 f.status('in_progress');await f.controller.recover(()=>true);expect(f.custody.read()).not.toBeNull();expect(states.at(-1)?.link).toBeNull();
 f.status('completed');await f.controller.recover(()=>true);expect(f.custody.read()?.sessionId).toBe(sessionId);expect(states.at(-1)?.link).toMatchObject({firmId:id,sessionId,routeId});expect(f.factory).toHaveBeenCalledTimes(1);
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
 expect(f.factory).not.toHaveBeenCalled();expect(f.custody.read()).not.toBeNull();await f.controller.recover(()=>true);expect(f.custody.read()?.sessionId).toBe(sessionId);
});
it('auth loss clears opaque custody and late SDK setup cannot resurrect audio',async()=>{
 const f=setup();await f.client.refresh();const device=deferred<typeof f.device>();f.factory.mockImplementationOnce(()=>device.promise);const live=f.controller.start(payload,()=>true);await waitFor(()=>expect(f.factory).toHaveBeenCalledTimes(1));f.client.invalidate();f.controller.dispose();device.resolve(f.device);await live;
 expect(f.device.connect).not.toHaveBeenCalled();expect(f.device.destroy).toHaveBeenCalled();await waitFor(()=>expect(JSON.parse(localStorage.getItem(CALLING_EXECUTION_KEY)??'[]')).toEqual([]));
});
it('source/navigation change disconnects a late SDK call and preserves opaque session custody',async()=>{
 const f=setup();await f.client.refresh();const connecting=deferred<typeof f.call>();f.device.connect.mockImplementationOnce(()=>connecting.promise);let current=true;const live=f.controller.start(payload,()=>current);await waitFor(()=>expect(f.device.connect).toHaveBeenCalledTimes(1));current=false;f.controller.dispose();connecting.resolve(f.call);await live;
 expect(f.call.disconnect).toHaveBeenCalledTimes(1);expect(f.device.destroy).toHaveBeenCalled();expect(f.custody.read()?.sessionId).toBe(sessionId);
 const reloaded=new CallingExecutionController(new CallingExecutionCustody(f.client),state=>states.push(state),f.ports);await reloaded.recover(()=>true);expect(f.custody.read()?.sessionId).toBe(sessionId);expect(f.factory).toHaveBeenCalledTimes(1);expect(f.requests.filter(r=>r.path.endsWith('/calls/session'))).toHaveLength(1);
});
it('review BE1 production adapter settles Device-only error before connect and fences a late Call',async()=>{
 const f=setup();await f.client.refresh();const connecting=deferred<CallingVoiceCall>();sdk.connect.mockReturnValue(connecting.promise);
 const controller=new CallingExecutionController(f.custody,state=>states.push(state),{device:browserCallingVoiceDevice,microphone:f.microphone});const live=controller.start(payload,()=>true);
 await waitFor(()=>expect(sdk.connect).toHaveBeenCalledTimes(1));const device=sdk.instances[0]!;expect(device.listenerCount('error')).toBe(1);expect(()=>device.emit('error',Error('fictional token expired'))).not.toThrow();await live;
 expect(states.at(-1)?.phase).toBe('unknown');expect(device.destroy).toHaveBeenCalledTimes(1);expect(device.listenerCount('error')).toBe(0);expect(f.custody.read()?.sessionId).toBe(sessionId);
 const next=new CallingExecutionController(f.custody,state=>states.push(state),f.ports);await next.recover(()=>true);expect(states.at(-1)?.link?.sessionId).toBe(sessionId);expect(f.factory).not.toHaveBeenCalled();
 connecting.resolve(f.call);await waitFor(()=>expect(f.call.disconnect).toHaveBeenCalledTimes(1));expect(sdk.connect).toHaveBeenCalledTimes(1);
});
it('review BE1 production adapter handles Device-only error after Call publication',async()=>{
 const f=setup();await f.client.refresh();sdk.connect.mockResolvedValue(f.call);const controller=new CallingExecutionController(f.custody,state=>states.push(state),{device:browserCallingVoiceDevice,microphone:f.microphone});const live=controller.start(payload,()=>true);
 await waitFor(()=>expect(states.at(-1)?.phase).toBe('ringing'));f.events.get('accept')?.();expect(states.at(-1)?.phase).toBe('connected');sdk.instances[0]!.emit('error',Error('fictional signalling failure'));await live;expect(states.at(-1)?.phase).toBe('unknown');expect(f.call.disconnect).toHaveBeenCalledTimes(1);expect(sdk.instances[0]!.listenerCount('error')).toBe(0);expect(f.custody.read()?.sessionId).toBe(sessionId);
});
it('review BE1 production adapter conserves Device errors emitted before controller subscription',async()=>{
 const f=setup();await f.client.refresh();const factory=async(token:string)=>{const made=await browserCallingVoiceDevice(token);sdk.instances[0]!.emit('error',Error('fictional early error'));return made;};const controller=new CallingExecutionController(f.custody,state=>states.push(state),{device:factory,microphone:f.microphone});await controller.start(payload,()=>true);
 expect(states.at(-1)?.phase).toBe('unknown');expect(sdk.connect).not.toHaveBeenCalled();expect(sdk.instances[0]!.destroy).toHaveBeenCalledTimes(1);expect(sdk.instances[0]!.listenerCount('error')).toBe(0);expect(f.custody.read()?.sessionId).toBe(sessionId);
});
it.each(['cancel','auth loss'])('review BE1 production adapter fences saved Device callbacks after %s',async kind=>{
 const f=setup();await f.client.refresh();const connecting=deferred<CallingVoiceCall>();sdk.connect.mockReturnValue(connecting.promise);const controller=new CallingExecutionController(f.custody,state=>states.push(state),{device:browserCallingVoiceDevice,microphone:f.microphone});const live=controller.start(payload,()=>true);
 await waitFor(()=>expect(sdk.connect).toHaveBeenCalledTimes(1));const device=sdk.instances[0]!,saved=device.listeners('error')[0]!;if(kind==='auth loss'){f.client.invalidate();controller.dispose();}else controller.stop();await live;const count=states.length;saved();expect(states).toHaveLength(count);connecting.resolve(f.call);await waitFor(()=>expect(f.call.disconnect).toHaveBeenCalledTimes(1));expect(device.listenerCount('error')).toBe(0);
 if(kind==='auth loss')await waitFor(()=>expect(f.custody.binding()).toBeNull());else expect(f.custody.read()?.sessionId).toBe(sessionId);
});
it('review SPEC1 terminal handoff survives other or empty selection, return, same-Firm projection refresh and explicit wrap',async()=>{
 const f=setup();await f.client.refresh();f.lose();await f.controller.start(payload,()=>true);const held=f.custody.read();
 function View({current}:{current:CallingContextData|null}){const [blocked,setBlocked]=useState(false),[link,setLink]=useState<CallingExecutionLink|null>(null);return <><CallingExecution client={f.client} context={current} paused={false} isScopeCurrent={()=>true} onBlockedChange={setBlocked} onLinkChange={setLink} ports={f.ports}/>{current?<CallingWrap client={f.client} subject={current.entry.subject} context={current} paused={blocked} executionLink={link} onPendingChange={()=>{}}/>:null}</>;}
 const otherContext:CallingContextData={...context,entry:{subject:{kind:'firm',firmId:other},label:'Other Firm'},firm:pluralFirmPageResponseSchema.parse({...page,read:{...page.read,firm:{...firm,id:other}}})};
 const view=render(<View current={otherContext}/>);await waitFor(()=>expect(screen.getByRole('button',{name:'Check exact call receipt'}).matches(':disabled')).toBe(true));expect(screen.getByLabelText('Actual outcome').matches(':disabled')).toBe(true);expect(f.custody.read()).toEqual(held);
 view.rerender(<View current={null}/>);expect(screen.getByRole('button',{name:'Check exact call receipt'}).matches(':disabled')).toBe(true);expect(f.requests.filter(r=>r.path.endsWith('/execution/receipt'))).toHaveLength(0);
 view.rerender(<View current={context}/>);fireEvent.click(screen.getByRole('button',{name:'Check exact call receipt'}));await screen.findByText(/Linked to the exact server-terminated/u);expect(f.custody.read()?.sessionId).toBe(sessionId);expect(screen.getByRole('button',{name:'Call in browser'}).matches(':disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('Actual outcome'),{target:{value:'not_interested'}});fireEvent.change(screen.getByLabelText('Private call notes'),{target:{value:'Independent private report'}});fireEvent.click(screen.getByRole('checkbox',{name:/personally performed/u}));
 // Same independently authorized Firm with a new projection object, as proof expiry publishes.
 view.rerender(<View current={{...context,firm:pluralFirmPageResponseSchema.parse(page)}}/>);await screen.findByText(/Linked to the exact server-terminated/u);expect((screen.getByLabelText('Private call notes') as HTMLTextAreaElement).value).toBe('Independent private report');
 fireEvent.click(screen.getByRole('button',{name:'Save outcome'}));await screen.findByRole('article',{name:'Recorded calling outcome'});expect(f.writes[0]).toMatchObject({kind:'firm',firmId:id,report:{callSessionId:sessionId,routeId,outcome:'not_interested'}});expect(f.custody.read()?.sessionId).toBe(sessionId);
 view.rerender(<View current={otherContext}/>);expect(screen.getByRole('button',{name:'Check exact call receipt'}).matches(':disabled')).toBe(true);view.rerender(<View current={context}/>);fireEvent.click(screen.getByRole('button',{name:'Check exact call receipt'}));await screen.findByRole('button',{name:'Finish terminated call handoff'});fireEvent.click(screen.getByRole('button',{name:'Finish terminated call handoff'}));await waitFor(()=>expect(f.custody.read()).toBeNull());expect(f.factory).not.toHaveBeenCalled();expect(f.requests.filter(r=>r.path.endsWith('/calls/session'))).toHaveLength(1);
});
it('server expired_unconsumed ends uncertainty without fabricating a call/session wrap link',async()=>{
 const f=setup();await f.client.refresh();f.lose();await f.controller.start(payload,()=>true);f.status('expired_unconsumed');await f.controller.recover(()=>true);expect(f.custody.read()).toBeNull();expect(states.at(-1)?.link).toBeNull();expect(f.factory).not.toHaveBeenCalled();
});
it('unavailable receipt never permits a replacement UUID or reconnect',async()=>{
 const f=setup();await f.client.refresh();f.lose();await f.controller.start(payload,()=>true);const held=f.custody.read();f.status('unavailable');await f.controller.recover(()=>true);expect(f.custody.read()).toEqual(held);await f.controller.start(payload,()=>true);expect(f.custody.read()).toEqual(held);expect(f.factory).not.toHaveBeenCalled();expect(f.requests.filter(r=>r.path.endsWith('/calls/session'))).toHaveLength(1);
});
it('mounted execution starts explicitly without a consent checkbox and passes only terminal exact session to promised wrap',async()=>{
 const f=setup();await f.client.refresh();function View(){const [blocked,setBlocked]=useState(false),[link,setLink]=useState<CallingExecutionLink|null>(null);return <><CallingExecution client={f.client} context={context} paused={false} isScopeCurrent={()=>true} onBlockedChange={setBlocked} onLinkChange={setLink} ports={f.ports}/><CallingWrap client={f.client} subject={{kind:'firm',firmId:id}} context={context} paused={blocked} executionLink={link} onPendingChange={()=>{}}/></>;}
 render(<View/>);await screen.findByRole('option',{name:identity.e164});expect(f.factory).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Call in browser'}).hasAttribute('disabled')).toBe(true);
 expect(screen.queryByRole('checkbox',{name:/authorized to place and record/u})).toBeNull();
 fireEvent.change(screen.getByLabelText('Browser call route'),{target:{value:routeId}});fireEvent.click(screen.getByRole('button',{name:'Call in browser'}));await waitFor(()=>expect(f.device.connect).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('button',{name:'Hang up / abandon setup'}));await screen.findByRole('button',{name:'Check exact call receipt'});fireEvent.click(screen.getByRole('button',{name:'Check exact call receipt'}));await screen.findByText(/Linked to the exact server-terminated/u);
 fireEvent.change(screen.getByLabelText('Actual outcome'),{target:{value:'interested'}});fireEvent.change(screen.getByLabelText('Private call notes'),{target:{value:'PRIVATE context not email'}});fireEvent.click(screen.getByRole('checkbox',{name:/personally performed/u}));fireEvent.change(screen.getByLabelText('Next action'),{target:{value:'promised_email'}});fireEvent.change(screen.getByLabelText('Promised email subject'),{target:{value:'Independent promise'}});fireEvent.change(screen.getByLabelText('Promised email body'),{target:{value:'Independent editable body'}});fireEvent.click(screen.getByRole('button',{name:'Save outcome and promised email'}));await screen.findByRole('article',{name:'Recorded calling outcome'});
 expect(f.writes[0]).toMatchObject({kind:'firm',firmId:id,report:{callSessionId:sessionId,routeId,outcome:'interested'},promisedEmail:{subject:'Independent promise',body:'Independent editable body'}});expect(JSON.stringify(f.writes[0]?.promisedEmail)).not.toContain('PRIVATE');expect(f.factory).toHaveBeenCalledTimes(1);
});

const audioPayload={purpose:'audio_test' as const,e164:'+14015550199',callingIdentityId:id};
it('an explicit audio test uses the shared engine without a Firm and keeps the destination out of durable custody',async()=>{
 const f=setup();await f.client.refresh();const live=f.controller.start(audioPayload,()=>true);
 await waitFor(()=>expect(f.device.connect).toHaveBeenCalledWith({sessionId}));
 expect(f.requests.filter(r=>r.path.includes('/browser/api/')).map(r=>r.path)).toEqual(['/browser/api/calling/setup','/browser/api/calling-identities','/browser/api/calls/access-token','/browser/api/calling/audio-test/session']);
 expect(f.requests.find(r=>r.path.endsWith('/audio-test/session'))?.body).toEqual({e164:audioPayload.e164,callingIdentityId:id,commandId:expect.any(String)});
 expect(f.custody.read()).toMatchObject({operation:'create_audio_test_session',sessionId});
 expect(localStorage.getItem(CALLING_EXECUTION_KEY)).not.toMatch(/1401555|EPHEMERAL|firmId|purpose/u);
 f.events.get('accept')?.();f.controller.mute();expect(f.call.mute).toHaveBeenCalledWith(true);f.controller.stop();await live;
 await f.controller.recover(()=>true);expect(states.at(-1)).toMatchObject({phase:'terminal',link:null,audioTestSessionId:sessionId});
 expect(f.custody.read()).not.toBeNull();await f.controller.resolveHandoff(()=>true);expect(f.custody.read()).toBeNull();expect(f.writes).toEqual([]);expect(f.factory).toHaveBeenCalledTimes(1);
});
it('lost audio-test acceptance survives reload and blocks business replacement until the same opaque receipt is resolved',async()=>{
 const f=setup();await f.client.refresh();f.lose();await f.controller.start(audioPayload,()=>true);const original=f.custody.read()!;
 const reloaded=new CallingExecutionController(new CallingExecutionCustody(f.client),s=>states.push(s),f.ports);
 await reloaded.start(payload,()=>true);expect(f.requests.filter(r=>r.path.endsWith('/calls/session'))).toHaveLength(0);
 f.off();f.status('in_progress');await reloaded.recover(()=>true);expect(f.custody.read()).toEqual(original);
 f.status('completed');await reloaded.recover(()=>true);
 expect(f.requests.filter(r=>r.path.endsWith('/audio-test/receipt')).map(r=>r.body)).toEqual([{commandId:original.commandId,payloadSHA256:original.payloadSHA256},{commandId:original.commandId,payloadSHA256:original.payloadSHA256}]);
 expect(f.factory).not.toHaveBeenCalled();expect(f.requests.filter(r=>r.path.endsWith('/audio-test/session'))).toHaveLength(1);expect(states.at(-1)?.link).toBeNull();
 await reloaded.resolveHandoff(()=>true);expect(f.custody.read()).toBeNull();
});
it('the same cross-tab lock excludes an audio test while a business microphone prompt is pending',async()=>{
 const f=setup();await f.client.refresh();const mic=deferred<void>();f.microphone.mockImplementationOnce(()=>mic.promise);const business=f.controller.start(payload,()=>true);
 await waitFor(()=>expect(f.microphone).toHaveBeenCalledTimes(1));const test=new CallingExecutionController(new CallingExecutionCustody(f.client),()=>{},f.ports);await test.start(audioPayload,()=>true);
 expect(f.microphone).toHaveBeenCalledTimes(1);expect(f.requests.filter(r=>r.path.endsWith('/audio-test/session'))).toHaveLength(0);f.controller.stop();mic.resolve();await business;
});
it('mounted audio test has an explicit start, automatic-recording notice and terminal finish without a sales outcome',async()=>{
 const f=setup();await f.client.refresh();const blocked=vi.fn();render(<CallingAudioTest client={f.client} paused={false} onBlockedChange={blocked} ports={f.ports}/>);
 await screen.findByRole('option',{name:identity.e164});expect(f.microphone).not.toHaveBeenCalled();expect(screen.queryByRole('checkbox')).toBeNull();expect(screen.getByText(/records both sides from answer/u)).toBeTruthy();
 fireEvent.change(screen.getByRole('textbox',{name:'Test phone number'}),{target:{value:'(401) 555-0199'}});fireEvent.click(screen.getByRole('button',{name:'Start audio test'}));await waitFor(()=>expect(f.device.connect).toHaveBeenCalledTimes(1));
 expect(screen.getByRole('textbox',{name:'Test phone number'})).toHaveProperty('value','');expect(screen.getByRole('textbox',{name:'Test phone number'}).matches(':disabled')).toBe(true);expect(blocked).toHaveBeenLastCalledWith(true);
 fireEvent.click(screen.getByRole('button',{name:'Hang up / abandon test'}));fireEvent.click(await screen.findByRole('button',{name:'Check test call status'}));await screen.findByRole('button',{name:'Finish audio test'});
 expect(screen.queryByLabelText('Actual outcome')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Finish audio test'}));await screen.findByText('Audio test finished.');expect(f.custody.read()).toBeNull();expect(blocked).toHaveBeenLastCalledWith(false);expect(f.writes).toEqual([]);
});
it('audio-test view does not hold the business terminal wrap or steal its receipt',async()=>{
 const f=setup();await f.client.refresh();f.lose();await f.controller.start(payload,()=>true);const blocked=vi.fn();render(<CallingAudioTest client={f.client} paused={false} onBlockedChange={blocked} ports={f.ports}/>);
 await screen.findByText(/A business call is active or uncertain/u);expect(blocked).toHaveBeenLastCalledWith(false);expect(screen.getByRole('button',{name:'Start audio test'}).matches(':disabled')).toBe(true);expect(screen.queryByRole('button',{name:'Check test call status'})).toBeNull();
 await f.controller.recover(()=>true);expect(states.at(-1)?.link).toMatchObject({firmId:id,sessionId});await f.controller.resolveHandoff(()=>true);await waitFor(()=>expect(f.custody.read()).toBeNull());
});
it('audio-test view clears entered destination and fences a late session after sign-out',async()=>{
 const f=setup();await f.client.refresh();render(<CallingAudioTest client={f.client} paused={false} onBlockedChange={()=>{}} ports={f.ports}/>);await screen.findByRole('option',{name:identity.e164});
 fireEvent.change(screen.getByRole('textbox',{name:'Test phone number'}),{target:{value:audioPayload.e164}});const waiting=deferred<Response>();f.wait(waiting.promise);fireEvent.click(screen.getByRole('button',{name:'Start audio test'}));
 await waitFor(()=>expect(f.requests.some(r=>r.path.endsWith('/audio-test/session'))).toBe(true));f.client.invalidate();waiting.resolve(Response.json({status:'accepted',replayed:false,result:{sessionId,expiresAt:new Date(Date.now()+60000).toISOString()}}));
 await waitFor(()=>expect(screen.queryByRole('textbox',{name:'Test phone number'})).toBeNull());expect(f.factory).not.toHaveBeenCalled();expect(f.writes).toEqual([]);
});
