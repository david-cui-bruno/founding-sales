import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestSourceCheck,runSourceCheck} from '../../sourcing/sourceCheck.ts';
import {listManualProspects} from '../../sourcing/manualProspects.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import type {PageFetchProvider} from '../../research/providers.ts';
let db:TestDatabase,seeded:TwoWorkspaces,writer:SessionQueryable,reader:SessionQueryable;
const context=(session:SessionQueryable)=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),session);
function signal(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
beforeAll(async()=>{
 db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);writer=await db.appRuntimeSession();reader=await db.appRuntimeSession();
 // The harness owns cluster cleanup. Server files/processes may be in a container.
 console.log('SOURCECHECK_LIST_RESOURCES',JSON.stringify({database:db.name,template:process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE],backendPid:Number((await db.session.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid'])}));
});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query("DELETE FROM jobs WHERE kind='sourcing.check'");await db.session.query('DELETE FROM daily_counters');});
afterAll(async()=>{await db?.drop();console.log('SOURCECHECK_LIST_DATABASE_DROPPED: owned sessions disconnected and disposable test database dropped');});
it.each(['checked','unavailable'] as const)('source-check/list overlap completes without a lock cycle and sees current %s visibility',async state=>{
 const input=manualOrdinaryFixture(767),saved=await withTransaction(writer,()=>saveCandidate(context(writer),input));if(!saved.ok)throw Error(saved.reason);
 expect(await withTransaction(writer,()=>requestSourceCheck(context(writer),{id:saved.value.id,expectedRevision:1}))).toMatchObject({ok:true});
 const job=(await db.session.query<{payload:{candidateId:string;checkId:string}}>("SELECT payload FROM jobs WHERE kind='sourcing.check'")).rows[0]!.payload;
 const reached=signal(),release=signal();let calls=0;
 // Controlled in-memory fixture only. No network/provider adapter is imported.
 const fixture:PageFetchProvider={providerKey:'controlled-local-source',fetchPages:async request=>{
  calls++;expect(request.urls).toEqual([input.sourceUrl]);reached.resolve();await release.promise;
  return state==='unavailable'?{ok:false,costCents:0,failureCode:'controlled_source_unavailable'}:
   {ok:true,costCents:0,value:{pages:[{url:input.sourceUrl,contentHash:'a'.repeat(64),contentType:'text/plain',body:new TextEncoder().encode('Synthetic retained page text.'),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}}};
 }};
 const readerPid=Number((await reader.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']);
 // The actual worker's business_uniqueness runner opens this transaction BEFORE
 // invoking runSourceCheck and obtains no candidate/source lock before the handler.
 const writing=withTransaction(writer,()=>runSourceCheck(context(writer),job,fixture));
 const writerOutcome=writing.then(()=>({ok:true as const}),error=>({ok:false as const,code:(error as {code?:string}).code}));
 let readerOutcome:Promise<unknown>|undefined;
 try{
  await reached.promise;
  readerOutcome=withTransaction(reader,()=>listManualProspects(context(reader),{state:'all',offset:0}));
  // Observe real PG lock contention, not a timing sleep or a copied implementation.
  await expect.poll(async()=>String((await db.session.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[readerPid])).rows[0]?.['wait_event_type'])).toBe('Lock');
 }finally{release.resolve();}
 const [writeResult,readResult]=await Promise.all([writerOutcome,readerOutcome?.then(value=>({ok:true as const,value}),error=>({ok:false as const,code:(error as {code?:string}).code}))]);
 expect(writeResult,'source-check transaction must not be a deadlock victim').toEqual({ok:true});
 expect(readResult,'list transaction must not be a deadlock victim').toMatchObject({ok:true,value:{ok:true,value:{hasMore:false}}});
 expect(readResult).toMatchObject({value:{value:{prospects:state==='checked'?[{candidateId:saved.value.id,revision:2}]:[]}}});
 const persisted=(await db.session.query<{source_check:{state:string};revision:number}>('SELECT source_check,revision FROM sourcing_candidates WHERE id=$1',[saved.value.id])).rows[0]!;
 expect(persisted.source_check.state).toBe(state);expect(persisted.revision).toBe(2);expect(calls).toBe(1);
 for(const table of ['firms','contacts','phone_routes','provider_reservations','outbound_messages','sourcing_manual_prospect_states'])expect((await db.session.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
