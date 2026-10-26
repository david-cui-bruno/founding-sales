// @vitest-environment jsdom
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {callingWrapInputSchema,type CallingWrapResult} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingCustody,CALLING_PENDING_KEY,callingTarget,installCallingCustody,type CallingStorage} from '../../src/client/CallingPending.ts';
import {dispatchCallingWrap,dispatchCallingSave,reconcileCalling} from '../../src/client/CallingDispatch.ts';
import {callingBrowserResult} from '../../src/server/callingBoundary.ts';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',third='00000000-0000-4000-8000-000000000003';
const input=()=>{const value=callingWrapInputSchema.parse({kind:'candidate',candidateId:id,expectedCandidateRevision:1,attemptId:other,report:{performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'conversation',note:'Private note must never be stored',callback:null},promisedEmail:{draftId:third,nextAction:'promised_email',subject:'Edited promised subject',body:'Edited promised body'}});if(value.kind!=='candidate')throw Error('Candidate fixture required');return value;};
const result:CallingWrapResult={kind:'candidate',activity:{candidateId:id,candidateRevision:1,attemptId:other,activityRevision:1},staleIntroductions:'not_applicable',followUp:{state:'queued_for_review',draftId:third,revision:1}};
function setup(shared?:CallingStorage,userId=id){const data=new Map<string,string>(),storage=shared??{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};let lose=false,receipt:unknown={state:'unknown'},answer:unknown={status:'accepted',replayed:false,result};const writes:unknown[]=[],reads:unknown[]=[];
 let hold:Promise<Response>|null=null;
 const send=vi.fn<typeof fetch>(async(url,init)=>{if(url==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId,deviceId:id,role:'admin',revision:'revision-one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()});if(String(url).endsWith('/receipt')){reads.push(JSON.parse(String(init?.body)));return Response.json(receipt);}writes.push(JSON.parse(String(init?.body)));expect(storage.getItem(CALLING_PENDING_KEY)).not.toBeNull();if(hold)return hold;if(lose)throw Error('Response lost');return Response.json(answer);});
 const client=new BrowserClient({fetch:send,storage,navigate:vi.fn(),randomUUID:()=>id}),custody=new CallingCustody(client,storage);return {client,custody,storage,writes,reads,hold:(p:Promise<Response>)=>{hold=p;},lose:()=>{lose=true;},receipt:(v:unknown)=>{receipt=v;},answer:(v:unknown)=>{answer=v;}};
}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async(_name:string,_options:unknown,work:()=>Promise<unknown>)=>work())}});});
afterEach(()=>{vi.unstubAllGlobals();sessionStorage.clear();localStorage.clear();});
describe('Calling exact command custody',()=>{
 it('stores only exact IDs/hash before dispatch and removes only confirmed accepted custody',async()=>{const f=setup();await f.client.refresh();expect(await dispatchCallingWrap(f.custody,input(),()=>true)).toEqual({state:'accepted',result});expect(f.writes).toHaveLength(1);expect(f.custody.all()).toEqual([]);f.client.dispose();});
 it('response loss survives reconstruction, blocks this subject only, receipt-only recovery never replays prose',async()=>{const f=setup();await f.client.refresh();f.lose();expect(await dispatchCallingWrap(f.custody,input(),()=>true)).toEqual({state:'unknown'});const bytes=f.storage.getItem(CALLING_PENDING_KEY)!;expect(bytes).not.toMatch(/Private note|Edited promised|manual_phone|conversation/u);const reload=new CallingCustody(f.client,f.storage),held=reload.read(callingTarget(input()))!;expect(held).not.toBeNull();expect(await dispatchCallingWrap(reload,input(),()=>true)).toEqual({state:'unknown'});expect(f.writes).toHaveLength(1);expect(reload.read(`firm:${third}`)).toBeNull();expect(await reconcileCalling(reload,held,()=>true)).toEqual({state:'unknown'});expect(reload.read(held.target)).toEqual(held);f.receipt({state:'accepted',acceptance:{operation:'wrap',result}});expect((await reconcileCalling(reload,held,()=>true)).state).toBe('accepted');expect(reload.all()).toEqual([]);expect(f.writes).toHaveLength(1);expect(JSON.stringify(f.reads)).not.toContain('Edited');f.client.dispose();});
 it('mismatched accepted receipt remains unknown rather than freeing custody',async()=>{const f=setup();await f.client.refresh();f.answer({status:'accepted',replayed:false,result:{...result,activity:{...result.activity,candidateId:third}}});expect(await dispatchCallingWrap(f.custody,input(),()=>true)).toEqual({state:'unknown'});expect(f.custody.all()).toHaveLength(1);f.client.dispose();});
 it('save binds draft/revision, known refusal clears but transport uncertainty does not',async()=>{const f=setup();await f.client.refresh();f.answer({status:'accepted',replayed:false,result:{draftId:third,revision:2}});expect(await dispatchCallingSave(f.custody,{operation:'update',draftId:third,expectedRevision:1,subject:'Independent',body:'Current prose'},()=>true)).toEqual({state:'accepted',result:{draftId:third,revision:2}});f.answer({status:'refused',replayed:false,reason:'stale_revision'});expect(await dispatchCallingSave(f.custody,{operation:'withdraw',draftId:third,expectedRevision:1},()=>true)).toEqual({state:'refused',reason:'stale_revision'});expect(f.custody.all()).toEqual([]);f.client.dispose();});
 it('actual invalidation clears custody while observer disposal or screen unmount does not',async()=>{const f=setup();await f.client.refresh();const uninstall=installCallingCustody(f.client,f.storage);f.lose();await dispatchCallingWrap(f.custody,input(),()=>true);uninstall();expect(f.custody.all()).toHaveLength(1);const stop=installCallingCustody(f.client,f.storage);f.client.invalidate();expect(f.storage.getItem(CALLING_PENDING_KEY)).toBeNull();stop();f.client.dispose();});
 it('fails before UUID or dispatch when current scope, WebLock or storage is unavailable',async()=>{const f=setup();await f.client.refresh();await expect(dispatchCallingWrap(f.custody,input(),()=>false)).rejects.toThrow();expect(f.writes).toEqual([]);Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});await expect(dispatchCallingWrap(f.custody,input(),()=>true)).rejects.toThrow();expect(f.writes).toEqual([]);f.client.dispose();});
 it('a second tab default custody blocks an unknown exact subject after the first lock releases',async()=>{const a=setup(localStorage),b=setup(localStorage);await a.client.refresh();await b.client.refresh();a.lose();const first=new CallingCustody(a.client),second=new CallingCustody(b.client);expect(await dispatchCallingWrap(first,input(),()=>true)).toEqual({state:'unknown'});expect(second.read(callingTarget(input()))).not.toBeNull();expect(await dispatchCallingWrap(second,input(),()=>true)).toEqual({state:'unknown'});expect(b.writes).toEqual([]);expect(JSON.stringify(second.all())).not.toMatch(/Private note|Edited promised/u);a.client.dispose();b.client.dispose();});
 it('malformed, duplicate or overlarge opaque custody fails closed before another dispatch',async()=>{const f=setup();await f.client.refresh();f.lose();await dispatchCallingWrap(f.custody,input(),()=>true);const held=f.custody.all()[0]!;for(const bytes of [JSON.stringify([held,held]),JSON.stringify([{...held,target:`firm:${third}`}]),JSON.stringify([{...held,body:'forbidden prose'}]),' '.repeat(131073)]){f.storage.setItem(CALLING_PENDING_KEY,bytes);expect(()=>f.custody.all()).toThrow();await expect(dispatchCallingWrap(f.custody,input(),()=>true)).rejects.toThrow();}expect(f.writes).toHaveLength(1);f.client.dispose();});
});

function controlledLocks(){
 const queues=new Map<string,Promise<void>>();let unblock!:()=>void;
 const barrier=new Promise<void>(resolve=>{unblock=resolve;});let pause=true;
 const request=vi.fn(async(name:string,_options:unknown,work:()=>Promise<unknown>)=>{
  const previous=queues.get(name)??Promise.resolve();let release!:()=>void;
  queues.set(name,new Promise<void>(resolve=>{release=resolve;}));await previous;
  try{if(name==='callie.calling-records'&&pause){pause=false;await barrier;}return await work();}finally{release();}
 });
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request}});return {request,unblock};
}
it('serializes independent registry mutations, never network waits, and reconciles only the exact target',async()=>{
 const a=setup(localStorage),b=setup(localStorage);await a.client.refresh();await b.client.refresh();a.lose();b.lose();const locks=controlledLocks();
 const x=dispatchCallingWrap(a.custody,input(),()=>true),y=dispatchCallingWrap(b.custody,{...input(),candidateId:third},()=>true);
 await vi.waitFor(()=>expect(locks.request.mock.calls.filter(([name])=>name==='callie.calling-records')).toHaveLength(2));expect(a.writes).toHaveLength(0);expect(b.writes).toHaveLength(0);locks.unblock();
 expect(await Promise.all([x,y])).toEqual([{state:'unknown'},{state:'unknown'}]);const held=a.custody.all();expect(held).toHaveLength(2);expect(b.custody.all()).toEqual(held);
 // Complete X while a third target is appended. X alone is removed.
 a.receipt({state:'refused',reason:'invalid_input'});const thirdInput={kind:'firm' as const,firmId:other,report:{performedByUser:true as const,outcome:'no_answer' as const}};
 await Promise.all([reconcileCalling(a.custody,a.custody.read(callingTarget(input()))!,()=>true),dispatchCallingWrap(b.custody,thirdInput,()=>true)]);
 expect(a.custody.all().map(p=>p.target).sort()).toEqual([callingTarget({...input(),candidateId:third}),`firm:${other}`].sort());
 expect(await dispatchCallingWrap(a.custody,{...input(),candidateId:third},()=>true)).toEqual({state:'unknown'});expect(b.writes).toHaveLength(2);a.client.dispose();b.client.dispose();
});
it('reads never prune by whole-array replacement or hide another tab longer current lease',async()=>{
 const f=setup();await f.client.refresh();f.lose();await dispatchCallingWrap(f.custody,input(),()=>true);const held=f.custody.all()[0]!,longer={...held,expiresAt:new Date(Date.now()+120000).toISOString()};
 const bytes=JSON.stringify([longer,{...held,target:`firm:${third}`,subject:{kind:'firm',firmId:third},attemptId:undefined,commandId:third,expiresAt:new Date(Date.now()-1).toISOString()}]);f.storage.setItem(CALLING_PENDING_KEY,bytes);expect(f.custody.read(held.target)).toEqual(longer);expect(f.storage.getItem(CALLING_PENDING_KEY)).toBe(bytes);f.client.dispose();
});
it.each(['invalid_time','already_exists'])('composed %s wrap refusal retains unrelated UNKNOWN and current authentication',async reason=>{
 const f=setup();await f.client.refresh();f.lose();await dispatchCallingWrap(f.custody,input(),()=>true);const held=f.custody.all()[0]!;const stop=installCallingCustody(f.client,f.storage);
 const mapped=callingBrowserResult('/calling/wrap',409,{status:'refused',replayed:false,reason});
 const client=new BrowserClient({fetch:async url=>url==='/browser/session'?Response.json(f.client.current):Response.json(mapped?.body??{error:'conflict'},{status:mapped?.status??409}),storage:f.storage,navigate:vi.fn(),randomUUID:()=>third});await client.refresh();const custody=new CallingCustody(client,f.storage),off=installCallingCustody(client,f.storage);
 expect(await dispatchCallingWrap(custody,{...input(),candidateId:third},()=>true)).toEqual({state:'refused',reason});expect(client.current?.status).toBe('signed_in');expect(custody.all()).toEqual([held]);off();stop();client.dispose();f.client.dispose();
});
it('holds a network response for X while Y dispatches and resolves without discarding X',async()=>{
 const a=setup(localStorage),b=setup(localStorage);await a.client.refresh();await b.client.refresh();let release!:(r:Response)=>void;a.hold(new Promise<Response>(resolve=>{release=resolve;}));const locks=controlledLocks();locks.unblock();
 const first=dispatchCallingWrap(a.custody,input(),()=>true);await vi.waitFor(()=>expect(a.writes).toHaveLength(1));const held=a.custody.read(callingTarget(input()))!;b.answer({status:'refused',replayed:false,reason:'invalid_time'});
 expect(await dispatchCallingWrap(b.custody,{...input(),candidateId:third},()=>true)).toEqual({state:'refused',reason:'invalid_time'});expect(a.custody.all()).toEqual([held]);release(Response.json({error:'source_unavailable'}));expect(await first).toEqual({state:'unknown'});expect(a.custody.all()).toEqual([held]);a.client.dispose();b.client.dispose();
});
it('auth clear joins the storage lock, fences a waiting prepare, and preserves another identity',async()=>{
 const f=setup();await f.client.refresh();f.lose();await dispatchCallingWrap(f.custody,input(),()=>true);const held=f.custody.all()[0]!,foreign={...held,identity:'other current identity',commandId:third};f.storage.setItem(CALLING_PENDING_KEY,JSON.stringify([held,foreign]));const stop=installCallingCustody(f.client,f.storage),locks=controlledLocks();
 const preparation=f.custody.prepare('wrap',{...input(),candidateId:third},()=>true);const rejected=expect(preparation).rejects.toThrow('Calling authority changed');await vi.waitFor(()=>expect(locks.request).toHaveBeenCalled());f.client.invalidate();expect(f.custody.all()).toEqual([]);expect(f.storage.getItem(CALLING_PENDING_KEY)).toContain(held.commandId);locks.unblock();await rejected;
 await vi.waitFor(()=>expect(JSON.parse(f.storage.getItem(CALLING_PENDING_KEY)!)).toEqual([foreign]));expect(f.writes).toHaveLength(1);stop();f.client.dispose();
});
it.each(['repeated null','initially unbound'] as const)('%s notifications preserve foreign exact UNKNOWN and prevent remint',async mode=>{
 const a=setup(localStorage,other),b=setup(localStorage);await b.client.refresh();b.lose();await dispatchCallingWrap(b.custody,input(),()=>true);const held=b.custody.read(callingTarget(input()))!;
 if(mode==='repeated null'){await a.client.refresh();a.lose();await dispatchCallingWrap(a.custody,input(),()=>true);}
 const stop=installCallingCustody(a.client,localStorage),locks=controlledLocks();a.client.invalidate();a.client.invalidate();expect(a.custody.all()).toEqual([]);
 // Queue a sentinel behind every notification cleanup so observation is not timing based.
 const settled=navigator.locks.request('callie.calling-records',{mode:'exclusive'},()=>undefined);locks.unblock();await settled;
 expect(b.custody.read(held.target)).toEqual(held);expect(JSON.parse(localStorage.getItem(CALLING_PENDING_KEY)!)).toEqual([held]);
 expect(await dispatchCallingWrap(new CallingCustody(b.client),input(),()=>true)).toEqual({state:'unknown'});expect(b.writes).toHaveLength(1);expect(b.custody.read(held.target)?.commandId).toBe(held.commandId);expect(b.custody.read(held.target)?.payloadSHA256).toBe(held.payloadSHA256);
 stop();a.client.dispose();b.client.dispose();
});
