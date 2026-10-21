import {beforeEach,expect,it,vi} from 'vitest';
import {createDesktopFixture,CLIENT_VERSION} from './support/desktopFixture.ts';
import {createAuthedClient} from '../src/main/authedClient.ts';
import type {HttpAnswer,HttpSend} from '../src/main/apiClient.ts';
import {createDialHandoff} from '../src/main/dialHandoff.ts';
import {resetBridges} from '../src/main/identityReset.ts';
import {OPERATION_IPC_CHANNELS} from '../src/shared/operations.ts';
import {rawDiscoveryEntry,discoveryReceipt} from './support/discoveryImportFixtures.ts';
const channels=vi.hoisted(()=>new Map<string,(event:unknown,input:unknown)=>Promise<unknown>>());
vi.mock('electron',()=>({ipcMain:{handle:(name:string,listener:(event:unknown,input:unknown)=>Promise<unknown>)=>channels.set(name,listener)}}));
beforeEach(()=>{vi.resetModules();channels.clear();});
const accepted={status:200,body:{status:'accepted',replayed:false,result:discoveryReceipt}};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

/** Real window registration, manager, normal client and sequential app reset order.
 * Memory-vault/scripted API fixture only. No live credential, network or database. */
async function setup(send:HttpSend){
  const mac=await createDesktopFixture();mac.script.role('admin');
  await mac.manager.signIn({workspaceId:mac.workspaceId,deviceLabel:'Synthetic importer fixture'});
  const onConnection=vi.fn((online:boolean)=>mac.manager.noteConnection(online));
  const onAuthRefusal=vi.fn(mac.manager.noteAuthRefusal);
  const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:CLIENT_VERSION,accessToken:()=>mac.manager.accessToken(),send,onConnection,onAuthRefusal});
  const {registerWindowBridges}=await import('../src/main/todayWindow.ts');
  const common={api,session:mac.manager};
  const bridges=registerWindowBridges({today:{...common,handoff:createDialHandoff({driver:{inspectVerifiedHandler:async()=> 'verified',isVerifiedHandlerCurrent:()=>true,openTelUri:async()=>{}}})},replies:common,research:common,crm:{...common,clientVersion:CLIENT_VERSION},sequences:common,settings:common,mailbox:{...common,openExternally:async()=>{}},chooseImportFile:async()=>null,sessionGeneration:()=>mac.manager.sessionGeneration()});
  const held=deferred<void>(),resets:Promise<void>[]=[];let cleanupEntered=false;
  const original=bridges.today.forget;
  bridges.today.forget=async()=>{cleanupEntered=true;await held.promise;return await original();};
  mac.manager.onSessionChange(()=>{resets.push(resetBridges([bridges.today,bridges.replies,bridges.crm,bridges.sequences,bridges.settings,bridges.mailbox,bridges.briefImport,bridges.recordings]));});
  const managerGeneration=mac.manager.sessionGeneration(),recordingsGeneration=bridges.recordings.identity.current();
  const invoke=()=>channels.get(OPERATION_IPC_CHANNELS.command)!(null,{operation:'sourcing.discoverySave',input:{...rawDiscoveryEntry(),commandId:'discovery126:manager-fixture'}});
  return {mac,bridges,invoke,onConnection,onAuthRefusal,managerGeneration,recordingsGeneration,cleanupEntered:()=>cleanupEntered,
    async stop(){held.resolve();await Promise.all(resets);await mac.stop();}};
}
it('actual token renewal role transition prevents dispatch while earlier bridge forget is still held',async()=>{
  const send=vi.fn<HttpSend>(async()=>accepted),f=await setup(send);
  try{
    f.mac.script.role('salesperson');f.mac.advance(3_600_000);
    expect(await f.invoke()).toEqual({result:null,reason:'session_changed_before_dispatch'});
    expect(f.cleanupEntered()).toBe(true);expect(f.mac.manager.sessionGeneration()).toBeGreaterThan(f.managerGeneration);
    expect(f.bridges.recordings.identity.current()).toBe(f.recordingsGeneration);
    expect((await f.mac.manager.state()).device?.role).toBe('salesperson');
    expect(send).not.toHaveBeenCalled();expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
  }finally{await f.stop();}
});
it('actual owner signout during held token lookup prevents dispatch before delayed bridge reset',async()=>{
  const send=vi.fn<HttpSend>(async()=>accepted),f=await setup(send);
  try{
    f.mac.advance(3_570_000);f.mac.script.hold('/auth/session/open');
    const pending=f.invoke();await vi.waitFor(()=>expect(f.mac.script.holding('/auth/session/open')).toBe(true));
    const signedOut=f.mac.manager.signOut();await vi.waitFor(()=>expect(f.cleanupEntered()).toBe(true));
    expect(f.bridges.recordings.identity.current()).toBe(f.recordingsGeneration);
    f.mac.script.release('/auth/session/open');
    expect(await pending).toEqual({result:null,reason:'session_changed_before_dispatch'});await signedOut;
    expect(send).not.toHaveBeenCalled();expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
  }finally{f.mac.script.release('/auth/session/open');await f.stop();}
});
it.each([200,403])('actual session transition suppresses already dispatched %s answer and effects before recordings reset',async status=>{
  const answer=deferred<HttpAnswer>(),send=vi.fn<HttpSend>(()=>answer.promise),f=await setup(send);
  try{
    const pending=f.invoke();await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1));
    f.mac.script.role('salesperson');f.mac.advance(3_600_000);await f.mac.manager.accessToken();
    expect(f.cleanupEntered()).toBe(true);expect(f.mac.manager.sessionGeneration()).toBeGreaterThan(f.managerGeneration);
    expect(f.bridges.recordings.identity.current()).toBe(f.recordingsGeneration);
    answer.resolve(status===200?accepted:{status,body:{reason:'device_revoked',privateBody:'must not escape'}});
    expect(await pending).toEqual({result:null,reason:'session_changed_after_dispatch'});
    expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
  }finally{answer.resolve(accepted);await f.stop();}
});
