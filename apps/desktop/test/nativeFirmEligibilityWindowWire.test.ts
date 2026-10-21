import {expect,it,vi} from 'vitest';
import {createAuthedClient,type AccessSession} from '../src/main/authedClient.ts';
import {createDialHandoff} from '../src/main/dialHandoff.ts';
import {resetBridges} from '../src/main/identityReset.ts';
import {OPERATION_IPC_CHANNELS} from '../src/shared/operations.ts';
import type {HttpSend} from '../src/main/apiClient.ts';
import {nativeId,nativeView} from './support/nativeFirmFixture.ts';
const ipc=vi.hoisted(()=>new Map<string,(event:unknown,input:unknown)=>Promise<unknown>>());
vi.mock('electron',()=>({ipcMain:{handle:(channel:string,handler:(event:unknown,input:unknown)=>Promise<unknown>)=>{ipc.set(channel,handler);}}}));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
type QualificationOperation='sourcing.firmQualification'|'sourcing.qualification'|'sourcing.qualify';
const commandId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const successBody=(operation:QualificationOperation)=>operation==='sourcing.qualify'?{status:'accepted',replayed:false,result:{runId:nativeId}}:nativeView();
const changed=(operation:QualificationOperation)=>operation==='sourcing.qualify'?{result:null,reason:'session_changed'}:{view:null,reason:'session_changed'};
async function fixture(accessToken:()=>Promise<AccessSession|null>=async()=>({token:'old',generation:1}),withGeneration=true,operation:QualificationOperation='sourcing.firmQualification',initialGeneration=1){
 vi.resetModules();ipc.clear();const {registerWindowBridges}=await import('../src/main/todayWindow.ts');
 let generation=initialGeneration;const onConnection=vi.fn(),onAuthRefusal=vi.fn(),send=vi.fn<HttpSend>(async()=>({status:200,body:successBody(operation)})),tokenRead=vi.fn(accessToken);
 const api=createAuthedClient({baseUrl:'https://example.test',clientVersion:'test',accessToken:tokenRead,send,onConnection,onAuthRefusal});
 const state=async()=>({online:true,stale:false,asOf:null,mayMutate:true,device:{role:'admin' as const},today:null}),session={state,refreshToday:state};
 const common={api,session};const bridges=registerWindowBridges({...(withGeneration?{sessionGeneration:()=>generation}:{}),today:{...common,handoff:createDialHandoff({driver:{inspectVerifiedHandler:async()=> 'verified',isVerifiedHandlerCurrent:()=>true,openTelUri:async()=>{}}})},replies:common,research:common,crm:{...common,clientVersion:'test'},sequences:common,settings:common,mailbox:{...common,openExternally:async()=>{}},chooseImportFile:async()=>null});
 const forgetGate=deferred<void>(),forgetStarted=deferred<void>();vi.spyOn(bridges.today,'forget').mockImplementation(async()=>{forgetStarted.resolve();await forgetGate.promise;return bridges.today.state();});
 const input=operation==='sourcing.firmQualification'?{firmId:nativeId}:operation==='sourcing.qualify'?{candidateId:nativeId,expectedRevision:1,commandId}:{candidateId:nativeId};
 return {send,tokenRead,onConnection,onAuthRefusal,read:()=>ipc.get(operation==='sourcing.qualify'?OPERATION_IPC_CHANNELS.command:OPERATION_IPC_CHANNELS.read)!(null,{operation,input}),async transition(){generation++;const recordingGeneration=bridges.recordings.identity.current();const reset=resetBridges([bridges.today,bridges.replies,bridges.research,bridges.crm,bridges.sequences,bridges.settings,bridges.mailbox,bridges.briefImport,bridges.recordings]);await forgetStarted.promise;expect(bridges.recordings.identity.current()).toBe(recordingGeneration);return async()=>{forgetGate.resolve();await reset;};}};
}
it('actual window wiring sends zero wrong-owner reads while earlier forget remains unresolved',async()=>{
 const token=deferred<AccessSession>(),f=await fixture(()=>token.promise),pending=f.read(),finishReset=await f.transition();
 token.resolve({token:'replacement',generation:2});expect(await pending).toEqual({view:null,reason:'session_changed'});
 expect(f.send).not.toHaveBeenCalled();expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();await finishReset();
});
it.each(['success','refusal','network'] as const)('actual window wiring drops stale %s and auth/connection effects before delayed recording reset',async kind=>{
 const f=await fixture(),started=deferred<void>(),response=deferred<void>();f.send.mockImplementationOnce(async()=>{started.resolve();await response.promise;if(kind==='network')throw new Error('offline');return kind==='refusal'?{status:401,body:{error:'device_revoked'}}:{status:200,body:nativeView()};});
 const pending=f.read();await started.promise;const finishReset=await f.transition();response.resolve();expect(await pending).toEqual({view:null,reason:'session_changed'});
 expect(f.send).toHaveBeenCalledTimes(1);expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();await finishReset();
});
it('actual window wiring fails closed without authoritative generation rather than using recordings identity',async()=>{
 const f=await fixture(undefined,false);expect(await f.read()).toEqual({view:null,reason:'session_changed'});expect(f.send).not.toHaveBeenCalled();expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
});
it('actual window wiring permits a current-owner read with the authoritative generation present',async()=>{
 const f=await fixture();expect(await f.read()).toMatchObject({view:{nativeEligibility:{status:'verified'}},reason:null});expect(f.send).toHaveBeenCalledTimes(1);expect(f.onConnection).toHaveBeenCalledWith(true);expect(f.onAuthRefusal).not.toHaveBeenCalled();
});
for(const operation of ['sourcing.qualification','sourcing.qualify'] as const){
 it(`${operation} registered real-client token wait refuses the replaced owner before delayed recordings cleanup`,async()=>{
  const token=deferred<AccessSession>(),tokenStarted=deferred<void>(),f=await fixture(()=>{tokenStarted.resolve();return token.promise;},true,operation);
  const pending=f.read();await tokenStarted.promise;const finishReset=await f.transition();token.resolve({token:'replacement',generation:2});
  expect(await pending).toEqual(changed(operation));expect(f.tokenRead).toHaveBeenCalledTimes(1);expect(f.send).not.toHaveBeenCalled();expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();await finishReset();
 });
 it.each(['success','refusal','network'] as const)(`${operation} registered real-client drops late %s with no retry or stale effects`,async kind=>{
  const f=await fixture(undefined,true,operation),started=deferred<void>(),response=deferred<void>();
  f.send.mockImplementationOnce(async()=>{started.resolve();await response.promise;if(kind==='network')throw new Error('offline');return kind==='refusal'?{status:401,body:{error:'device_revoked'}}:{status:200,body:successBody(operation)};});
  const pending=f.read();await started.promise;const finishReset=await f.transition();response.resolve();
  expect(await pending).toEqual(changed(operation));expect(f.send).toHaveBeenCalledTimes(1);expect(f.tokenRead).toHaveBeenCalledTimes(1);expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();await finishReset();
 });
 it.each([undefined,NaN,Infinity])(`${operation} registered handler fails closed with missing/nonfinite authoritative generation %s`,async generation=>{
  const f=await fixture(undefined,generation!==undefined,operation,generation);expect(await f.read()).toEqual(changed(operation));expect(f.tokenRead).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
 });
 it(`${operation} registered real-client permits the current owner on the unchanged route and envelope`,async()=>{
  const f=await fixture(undefined,true,operation);expect(await f.read()).toMatchObject(operation==='sourcing.qualify'?{result:{runId:nativeId},reason:null}:{view:{candidateId:nativeView().candidateId},reason:null});
  expect(f.send).toHaveBeenCalledTimes(1);expect(f.onConnection).toHaveBeenCalledWith(true);expect(f.onAuthRefusal).not.toHaveBeenCalled();
  expect(f.send.mock.calls[0]![0]).toBe(`https://example.test/sourcing/qualification/${operation==='sourcing.qualify'?'request':'read'}`);
  expect(JSON.parse(f.send.mock.calls[0]![1]!.body!)).toEqual(operation==='sourcing.qualify'?{candidateId:nativeId,expectedRevision:1,commandId,clientVersion:'test'}:{candidateId:nativeId});
 });
}
