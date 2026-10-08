import {expect,it,vi} from 'vitest';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {createNotificationRuntime} from '../src/main/notifications/runtime.ts';
import type {NotificationIdentity} from '../src/main/notifications/runner.ts';
const identity={workspaceId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222'};
const native={supported:()=>true,history:async()=>[],create:vi.fn(()=>{throw new Error('No actionable items in this fixture');})};
const now=()=> '2026-10-08T18:00:00.000Z';
function client(seen:string[]){return createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url)=>{
 seen.push(url);return {status:200,body:{version:1,...identity,asOf:now(),items:[],recoveries:[]}};
}});}
it('does not start native work when a late identity read completes after suspend',async()=>{
 let release:((value:NotificationIdentity|null)=>void)|undefined;
 const seen:string[]=[];
 const runtime=createNotificationRuntime({api:client(seen),native,identity:()=>new Promise(resolve=>{release=resolve;}),generation:()=>0,now,openTarget:()=>{}});
 runtime.start();runtime.stop({clear:false});release?.(identity);
 await Promise.resolve();await Promise.resolve();
 expect(seen).toEqual([]);expect(runtime.status().state).toBe('stopped');
});
it('checks current actions when awake and on resume, and stops checking while suspended',async()=>{
 const seen:string[]=[];
 const runtime=createNotificationRuntime({api:client(seen),native,identity:async()=>identity,generation:()=>0,now,openTarget:()=>{}});
 try{
  runtime.start();await vi.waitFor(()=>expect(runtime.status().state).toBe('ready'));
  runtime.stop({clear:false});const count=seen.length;runtime.wake();await Promise.resolve();
  expect(seen).toHaveLength(count);expect(runtime.status().state).toBe('stopped');
  runtime.start();await vi.waitFor(()=>expect(seen.length).toBeGreaterThan(count));
  expect(seen.every(url=>url==='https://api.example.test/notifications/actions')).toBe(true);
 }finally{runtime.stop();}
});
