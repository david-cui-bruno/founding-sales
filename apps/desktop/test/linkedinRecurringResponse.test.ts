// Keep Node file URLs for the real migration/fixture modules and mount the
// renderer in the existing controlled DOM seam.
import './support/componentDom.mts';
import {beforeAll,afterAll,afterEach,it,expect} from 'vitest';
import {createElement} from 'react';
import {fileURLToPath} from 'node:url';
import {render,screen,cleanup} from '@testing-library/react';
import {linkedinRecurringViewSchema,type LinkedinRecurringView} from '@fss/contracts';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {linkedinRecurringPostingOperations} from '../src/main/social/linkedinRecurringPostingOperations.ts';
import {LinkedinRecurringPosting} from '../src/renderer/social/LinkedinRecurringPosting.tsx';

let stopPostgres:(()=>Promise<void>)|undefined;
/** The test-only server lifecycle port. The server/worker fixture is loaded at
 * runtime so desktop's strip-only typecheck does not compile server syntax under
 * a different package's compiler contract. Public answers remain schema checked. */
interface RecurringServerFixture{
 prepare():Promise<unknown>;
 run():Promise<unknown>;
 submit():Promise<{outcome:unknown}>;
 call(path:string,body:unknown):Promise<{status:number;body:unknown}>;
 f:{stop():Promise<void>};
}
let fixture:RecurringServerFixture|undefined;
let current:LinkedinRecurringView;
beforeAll(async()=>{
 // Reuse the real local PostgreSQL and ordinary governed input/worker/delivery
 // fixture. No response is hand-written and no positive ledger is seeded.
 const setupRelative='../../../packages/domain/db/testing/globalSetup.ts';
 const fixtureRelative='../../api/test/support/linkedinRecurringFixture.ts';
 const setupPath=fileURLToPath(new URL(setupRelative,import.meta.url));
 const fixturePath=fileURLToPath(new URL(fixtureRelative,import.meta.url));
 const {default:setupPostgres}:{default:()=>Promise<()=>Promise<void>>}=await import(setupPath);
 const {recurringFixture}:{recurringFixture:()=>Promise<RecurringServerFixture>}=await import(fixturePath);
 stopPostgres=await setupPostgres();fixture=await recurringFixture();
 await fixture.prepare();await fixture.run();
 expect((await fixture.submit()).outcome).toEqual({state:'scheduled'});
 const response=await fixture.call('/social/linkedin-recurring/read',{});
 expect(response.status).toBe(200);
 current=linkedinRecurringViewSchema.parse(response.body);
 expect(current.items[0]).toMatchObject({state:'receipt',receiptId:'controlled-receipt',submissionId:expect.any(String),spendCents:1});
},60_000);
afterEach(cleanup);
afterAll(async()=>{await fixture?.f.stop();await stopPostgres?.();},60_000);

function extend(view:LinkedinRecurringView,level:'root'|'item'|'both'){
 return {...view,...(level!=='item'?{compatibleRoot:{schemaRevision:2}}:{}),items:view.items.map(item=>({...item,...(level!=='root'?{compatibleItem:{observationClass:'controlled'}}:{})}))};
}
it.each(['root','item','both'] as const)('actual recurring response with added %s fields flows through main operation and mounted owner read',async level=>{
 const extended=extend(current,level);
 const api=createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:'1.4.0',accessToken:async()=>({token:'controlled',generation:1}),send:async()=>({status:200,body:extended})});
 const host=linkedinRecurringPostingOperations({api,generation:()=>1});
 const answer=await host['social.recurringPosting']();
 expect(answer).toEqual({view:current,reason:null});
 // Additive API fields may also reach the renderer boundary. Exercise its real
 // parser, not only the main-process projection that already stripped them.
 render(createElement(LinkedinRecurringPosting,{ports:{read:async()=>({view:extended,reason:null})}}));
 await screen.findByText(/Platform receipt recorded/);
 expect(screen.getByText(/Receipt: controlled-receipt/)).toBeTruthy();
 expect(screen.getByText(/Submission marker:/)).toBeTruthy();
 expect(screen.getByText(/\$0.01/)).toBeTruthy();
 expect(screen.queryByText(/Current recurring state is unavailable/)).toBeNull();
 expect(screen.queryByRole('button',{name:/approve|enable/i})).toBeNull();
});
it.each(['root','item','both'] as const)('mounted renderer independently accepts added %s fields on the actual response',async level=>{
 render(createElement(LinkedinRecurringPosting,{ports:{read:async()=>({view:extend(current,level),reason:null})}}));
 await screen.findByText(/Platform receipt recorded/);
 expect(screen.getByText(/Receipt: controlled-receipt/)).toBeTruthy();
 expect(screen.getByText(/Submission marker:/)).toBeTruthy();
 expect(screen.queryByText(/Current recurring state is unavailable/)).toBeNull();
});
it('additive tolerance does not accept a changed known field or new authority state',async()=>{
 for(const invalid of [{...current,items:current.items.map(item=>({...item,spendCents:'1'}))},{...current,items:current.items.map(item=>({...item,state:'enabled'}))}]){
  expect(linkedinRecurringViewSchema.safeParse(invalid).success).toBe(false);
  const api=createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:'1.4.0',accessToken:async()=>({token:'controlled',generation:1}),send:async()=>({status:200,body:invalid})});
  expect((await linkedinRecurringPostingOperations({api,generation:()=>1})['social.recurringPosting']()).view).toBeNull();
 }
});
