import {expect,it,vi} from 'vitest';
import {createAuthedClient,type AccessSession,type AuthedClient} from '../src/main/authedClient.ts';
import type {HttpAnswer,HttpSend} from '../src/main/apiClient.ts';
import {registerOperations,type OperationHostDeps} from '../src/main/operationHost.ts';
import {OPERATION_IPC_CHANNELS} from '../src/shared/operations.ts';
import {rawDiscoveryEntry,discoveryReceipt} from './support/discoveryImportFixtures.ts';
import {prepareDiscoveryBatch} from '../src/renderer/sourcing/discoveryImportBatch.ts';
const accepted={status:200,body:{status:'accepted',replayed:false,result:discoveryReceipt}};
function registered(api:AuthedClient,generation:()=>number=()=>0){
  const channels=new Map<string,(input:unknown)=>Promise<unknown>>();
  // Same API + recordings identity seam used by registryTraffic and bookingCapacity tests.
  const deps={api,recordings:{identity:{current:generation}}} as unknown as OperationHostDeps;
  registerOperations(deps,(channel,listener)=>channels.set(channel,listener));
  return (input:unknown)=>channels.get(OPERATION_IPC_CHANNELS.command)!({operation:'sourcing.discoverySave',input});
}
it('registered command reaches only the normal API envelope and retains deterministic payload/IDs on replay',async()=>{
  const seen:Array<{url:string;body:unknown}>=[];
  const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.56',accessToken:async()=>({token:'synthetic-session',generation:0}),send:async(url,init)=>{seen.push({url,body:JSON.parse(init.body!)});return {...accepted,body:{...accepted.body,replayed:seen.length>1}};}});
  const invoke=registered(api),batch=await prepareDiscoveryBatch(JSON.stringify([rawDiscoveryEntry()])),command=batch.commands[0]!;
  expect(await invoke(command)).toEqual({result:discoveryReceipt,reason:null});expect(await invoke(command)).toEqual({result:discoveryReceipt,reason:null});
  expect(seen).toEqual(Array.from({length:2},()=>({url:'https://api.example.test/sourcing/candidates/discovery/save-v1',body:{...command,clientVersion:'1.0.56'}})));
});
it('registered input rejects spoofed owner/version and invalid payload before transport',async()=>{
  const send=vi.fn<HttpSend>(async()=>accepted),api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.56',accessToken:async()=>({token:'synthetic',generation:0}),send}),invoke=registered(api);
  const command={...rawDiscoveryEntry(),commandId:'discovery126:fixture'};
  for(const extra of [{clientVersion:'99.0.0'},{workspaceId:discoveryReceipt.id},{actorId:discoveryReceipt.id},{body:'forbidden'}])await expect(invoke({...command,...extra})).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
it.each([401,403,409,426,503])('registered operation preserves bounded %s refusal without retry',async status=>{
  const send=vi.fn(async()=>({status,body:{reason:status===503?'http_503':'source_conflict'}})),api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.56',accessToken:async()=>({token:'synthetic',generation:0}),send});
  expect(await registered(api)({...rawDiscoveryEntry(),commandId:'discovery126:fixture'})).toEqual({result:null,reason:status===503?'http_503':'source_conflict'});expect(send).toHaveBeenCalledTimes(1);
});
it.each(['owner','role'] as const)('delayed-token %s switch prevents any registered save dispatch',async _kind=>{
  let generation=0,resolve!:(access:AccessSession)=>void;
  const send=vi.fn<HttpSend>(async()=>accepted),accessToken=vi.fn(()=>new Promise<AccessSession>(done=>{resolve=done;}));
  const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.56',accessToken,send}),pending=registered(api,()=>generation)({...rawDiscoveryEntry(),commandId:'discovery126:fixture'});
  generation++;resolve({token:'replacement-synthetic-session',generation});
  expect(await pending).toEqual({result:null,reason:'session_changed_before_dispatch'});expect(send).not.toHaveBeenCalled();
});
it.each([200,403])('late dispatched %s answer is unknown, cannot expose old body or apply auth/connection side effects',async status=>{
  let generation=0,resolve!:(answer:HttpAnswer)=>void;
  const onConnection=vi.fn(),onAuthRefusal=vi.fn(),send=vi.fn(()=>new Promise<HttpAnswer>(done=>{resolve=done;}));
  const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.56',accessToken:async()=>({token:'synthetic',generation}),send,onConnection,onAuthRefusal});
  const pending=registered(api,()=>generation)({...rawDiscoveryEntry(),commandId:'discovery126:fixture'});
  await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1));generation++;
  resolve(status===200?accepted:{status,body:{reason:'device_revoked',privateBody:'must not escape'}});
  expect(await pending).toEqual({result:null,reason:'session_changed_after_dispatch'});expect(onConnection).not.toHaveBeenCalled();expect(onAuthRefusal).not.toHaveBeenCalled();
});
it('optional guard prevents token lookup when already stale and omitted guard preserves legacy envelope behavior',async()=>{
  const accessToken=vi.fn(async()=>({token:'synthetic',generation:0})),send=vi.fn<HttpSend>(async()=>accepted),api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.56',accessToken,send});
  expect(await api.command('/example',{},value=>value,{commandId:'stable',current:()=>false})).toEqual({ok:false,reason:'session_changed_before_dispatch',offline:false});
  expect(accessToken).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  expect(await api.command('/example',{original:'payload'},value=>value,{commandId:'stable'})).toEqual({ok:true,value:discoveryReceipt});
  expect(JSON.parse(send.mock.calls[0]![1]!.body!)).toEqual({commandId:'stable',clientVersion:'1.0.56',original:'payload'});
});
