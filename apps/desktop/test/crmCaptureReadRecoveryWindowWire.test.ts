import { afterEach, expect, it, vi } from 'vitest';
import { createAuthedClient, type AccessSession } from '../src/main/authedClient.ts';
import { createDialHandoff } from '../src/main/dialHandoff.ts';
import { resetBridges } from '../src/main/identityReset.ts';
import { OPERATION_IPC_CHANNELS } from '../src/shared/operations.ts';
import type { HttpSend } from '../src/main/apiClient.ts';
import { createDesktopFixture } from './support/desktopFixture.ts';

const ipc=vi.hoisted(()=>new Map<string,(event:unknown,input:unknown)=>Promise<unknown>>());
vi.mock('electron',()=>({ipcMain:{handle:(channel:string,handler:(event:unknown,input:unknown)=>Promise<unknown>)=>{ipc.set(channel,handler);}}}));
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const stop of cleanups.splice(0).reverse())await stop();});
const id='11111111-1111-4111-8111-111111111111';
type Operation='crm.captureReadRecoveryRead'|'crm.captureReadRecoveryRequest';
const inputFor=(operation:Operation)=>operation==='crm.captureReadRecoveryRead'?{mailboxId:id}:{mailboxId:id,expectedGeneration:1,incidentId:id,expectedRecoveryBinding:'a'.repeat(64),commandId:id};
const status={mailboxId:id,generation:1,eligible:true,incidentId:id,recoveryBinding:'a'.repeat(64),reason:null,attempt:null,sendingUnchanged:true,holdsUnchanged:true,providerCoverage:'unproven'};
const acknowledgment={attemptId:id,state:'queued',sendingUnchanged:true,holdsUnchanged:true};
const successFor=(operation:Operation)=>operation==='crm.captureReadRecoveryRead'?status:{status:'accepted',replayed:false,result:acknowledgment};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

/** Real session manager -> actual todayWindow -> operationHandlers -> real AuthedClient.
 * Only Electron IPC and provider HTTP are controlled. Recorder identity is deliberately
 * frozen behind the first sequential bridge cleanup while the real manager advances. */
async function fixture(operation:Operation,options:{accessToken?:()=>Promise<AccessSession|null>;counter?:'missing'|'nan'|'infinity'}={}){
 vi.resetModules();ipc.clear();
 const {registerWindowBridges}=await import('../src/main/todayWindow.ts');
 const mac=await createDesktopFixture();mac.script.browserFinished(true);mac.script.role('admin');
 await mac.manager.state();await mac.manager.signIn({workspaceId:mac.workspaceId});
 const tokenRead=vi.fn(options.accessToken??(()=>mac.manager.accessToken()));
 const onConnection=vi.fn(),onAuthRefusal=vi.fn(),send=vi.fn<HttpSend>(async()=>({status:200,body:successFor(operation)}));
 const api=createAuthedClient({baseUrl:'https://example.test',clientVersion:'1.4.0',accessToken:tokenRead,send,onConnection,onAuthRefusal});
 const common={api,session:mac.manager};
 const counter=options.counter==='nan'?()=>NaN:options.counter==='infinity'?()=>Infinity:()=>mac.manager.sessionGeneration();
 const bridges=registerWindowBridges({...(options.counter==='missing'?{}:{sessionGeneration:counter}),today:{...common,handoff:createDialHandoff({driver:{inspectVerifiedHandler:async()=>'verified',isVerifiedHandlerCurrent:()=>true,openTelUri:async()=>{}}})},replies:common,research:common,crm:{...common,clientVersion:'1.4.0'},sequences:common,settings:common,mailbox:{...common,openExternally:async()=>{}},chooseImportFile:async()=>null});
 const forgetGate=deferred<void>(),forgetStarted=deferred<void>();let reset:Promise<void>|undefined;
 vi.spyOn(bridges.today,'forget').mockImplementation(async()=>{forgetStarted.resolve();await forgetGate.promise;return bridges.today.state();});
 mac.manager.onSessionChange(()=>{reset=resetBridges([bridges.today,bridges.replies,bridges.crm,bridges.sequences,bridges.settings,bridges.mailbox,bridges.briefImport,bridges.recordings]);});
 cleanups.push(async()=>{forgetGate.resolve();await reset;await mac.stop();});
 return {send,tokenRead,onConnection,onAuthRefusal,manager:mac.manager,recordings:bridges.recordings,
  invoke:()=>ipc.get(operation==='crm.captureReadRecoveryRead'?OPERATION_IPC_CHANNELS.read:OPERATION_IPC_CHANNELS.command)!(null,{operation,input:inputFor(operation)}),
  async transition(){const before=mac.manager.sessionGeneration(),recording=bridges.recordings.identity.current();await mac.manager.noteAuthRefusal('device_revoked',before);await forgetStarted.promise;expect(mac.manager.sessionGeneration()).toBeGreaterThan(before);expect(bridges.recordings.identity.current()).toBe(recording);},
 };
}
for(const operation of ['crm.captureReadRecoveryRead','crm.captureReadRecoveryRequest'] as const){
 it(`${operation}: real manager transition blocks token-renewal dispatch while recorder cleanup is held`,async()=>{
  const token=deferred<AccessSession>(),started=deferred<void>();
  const f=await fixture(operation,{accessToken:()=>{started.resolve();return token.promise;}});
  const pending=expect(f.invoke()).rejects.toThrow('identity_changed');await started.promise;await f.transition();
  token.resolve({token:'replacement-session-test-only',generation:f.manager.sessionGeneration()});await pending;
  expect(f.tokenRead).toHaveBeenCalledTimes(1);expect(f.send).not.toHaveBeenCalled();expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
 });
 for(const outcome of ['200','401','network'] as const)it(`${operation}: real manager transition drops late ${outcome} before recorder cleanup and all transport side effects`,async()=>{
  const f=await fixture(operation),started=deferred<void>(),release=deferred<void>();
  f.send.mockImplementationOnce(async()=>{started.resolve();await release.promise;if(outcome==='network')throw new Error('controlled offline');return outcome==='401'?{status:401,body:{reason:'device_revoked'}}:{status:200,body:successFor(operation)};});
  const pending=expect(f.invoke()).rejects.toThrow('identity_changed');await started.promise;await f.transition();release.resolve();await pending;
  expect(f.send).toHaveBeenCalledTimes(1);expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
 });
 for(const counter of ['missing','nan','infinity'] as const)it(`${operation}: actual window fails closed with ${counter} manager counter despite a finite recorder`,async()=>{
  const f=await fixture(operation,{counter});expect(Number.isFinite(f.recordings.identity.current())).toBe(true);
  await expect(f.invoke()).rejects.toThrow('identity_changed');expect(f.tokenRead).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
 });
 it(`${operation}: actual current owner manager permits exactly the frozen route and command envelope`,async()=>{
  const f=await fixture(operation);expect(await f.invoke()).toEqual(operation==='crm.captureReadRecoveryRead'?status:acknowledgment);
  expect(f.send).toHaveBeenCalledTimes(1);expect(f.onConnection).toHaveBeenCalledWith(true);expect(f.onAuthRefusal).not.toHaveBeenCalled();
  expect(f.send.mock.calls[0]![0]).toBe(`https://example.test/crm/business/capture-read-recovery/${operation==='crm.captureReadRecoveryRead'?'read':'request'}`);
  expect(JSON.parse(f.send.mock.calls[0]![1].body!)).toEqual({...inputFor(operation),...(operation==='crm.captureReadRecoveryRequest'?{clientVersion:'1.4.0'}:{})});
 });
}
