import './support/componentDom.mts';
import {beforeAll,afterAll,afterEach,it,expect} from 'vitest';
import {createElement} from 'react';
import {fileURLToPath} from 'node:url';
import {render,screen,cleanup} from '@testing-library/react';
import {linkedinRecurringViewSchema} from '@fss/contracts';
import {LinkedinRecurringPosting} from '../src/renderer/social/LinkedinRecurringPosting.tsx';

// Runtime-only canonical public fixture port, as in the response compatibility
// test. Server syntax keeps its own package compiler contract.
interface RecurringServerFixture{
 prepare():Promise<unknown>;
 run():Promise<unknown>;
 call(path:string,body:unknown):Promise<{status:number;body:unknown}>;
 queue():Promise<{items:{postId:string;revision:number}[]}>;
 read():Promise<unknown>;
 f:{stop():Promise<void>};
}
let stopPostgres:(()=>Promise<void>)|undefined;
let makeFixture:()=>Promise<RecurringServerFixture>;
let command:(input:object)=>object;
beforeAll(async()=>{
 const setupRelative='../../../packages/domain/db/testing/globalSetup.ts';
 const fixtureRelative='../../api/test/support/linkedinRecurringFixture.ts';
 const setupPath=fileURLToPath(new URL(setupRelative,import.meta.url));
 const fixturePath=fileURLToPath(new URL(fixtureRelative,import.meta.url));
 const {default:setupPostgres}:{default:()=>Promise<()=>Promise<void>>}=await import(setupPath);
 const {recurringFixture,recurringCommand}:{recurringFixture:()=>Promise<RecurringServerFixture>;recurringCommand:(input:object)=>object}=await import(fixturePath);
 stopPostgres=await setupPostgres();makeFixture=recurringFixture;command=recurringCommand;
},60_000);
afterEach(cleanup);
afterAll(async()=>{await stopPostgres?.();},60_000);

it.each(['adapter_unavailable','cancel_before_begin'] as const)('mounted recurring read displays actual public %s as known stopped with conserved spend',async stop=>{
 const h=await makeFixture();try{
  await h.prepare();await h.run();
  const item=(await h.queue()).items[0]!;
  const path=stop==='adapter_unavailable'?'/social/delivery/hold':'/social/posts/cancel';
  const answer=await h.call(path,command({postId:item.postId,expectedRevision:item.revision,...(stop==='adapter_unavailable'?{reason:stop}:{})}));
  expect(answer.status).toBe(200);
  const view=linkedinRecurringViewSchema.parse(await h.read());
  render(createElement(LinkedinRecurringPosting,{ports:{read:async()=>({view,reason:null})}}));
  await screen.findByText(stop==='adapter_unavailable'?/Skipped, no catch-up: adapter unavailable/:/Skipped, no catch-up: delivery cancelled/);
  expect(screen.getByText(/\$0.01/)).toBeTruthy();
  expect(screen.queryByText(/Queued for existing desktop scheduling/)).toBeNull();
  expect(screen.queryByText(/Inspect original submission, never replay/)).toBeNull();
  expect(screen.queryByRole('button',{name:/approve|enable|retry/i})).toBeNull();
 }finally{await h.f.stop();}
});
