import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {seedPreparedProspect} from '@fss/domain/test/sourcing/preparedProspectsPgFixture.ts';
import {enqueueJob} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {runOnce} from '../src/runner/jobRunner.ts';
import {sourcingCallableRankHandler,sourcingCallableRankSource} from '../src/handlers/sourcingCallableRank.ts';
import {registerHandlers,workerSourceFlags,workerDueWorkSources} from '../src/bootstrap/main.ts';
// ADR0034: the advisory Callable-today rank is refreshed by a database-only job, one per workspace per minute, while rows are stale.
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase();});afterAll(async()=>{await db.drop();});
it('schedules one rank refresh per stale workspace and minute, writes rank rows with no outbound work, then goes quiet',async()=>{
 const seed=await seedTwoWorkspaces(db.session),ctx=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),db.session);
 await seedPreparedProspect(ctx,1,{extraBlocks:[{id:'contact',text:'Questions about your rental? Call us at (617) 555-0100.'}]});
 await seedPreparedProspect(ctx,2);
 // Fifty-two candidates need two batches: the handler is chunked, one bounded batch per call in the runner's own transaction.
 for(let i=3;i<=52;i++)await seedPreparedProspect(ctx,i,{extraBlocks:[{id:'contact',text:'Questions about your rental? Call us at (617) 555-0100.'}]});
 const now=new Date().toISOString();expect(await sourcingCallableRankSource(false).find(db.session,now)).toEqual([]);
 const source=sourcingCallableRankSource(true);
 await withTransaction(db.session,async()=>{for(let i=0;i<2;i++)for(const job of await source.find(db.session,now))await enqueueJob(db.session,job);});
 expect((await db.session.query<{workspace_id:string}>("SELECT workspace_id FROM jobs WHERE kind='sourcing.callable_rank'")).rows).toEqual([{workspace_id:seed.alpha.workspaceId}]);
 const registry=new HandlerRegistry().register(sourcingCallableRankHandler());
 expect((await runOnce(db.session,{registry,owner:'callable-rank-test',limit:5})).failed).toBe(0);
 expect((await db.session.query<{rank:number|null;n:string}>('SELECT rank,count(*) AS n FROM sourcing_callable_ranks GROUP BY rank ORDER BY rank NULLS LAST')).rows).toEqual([{rank:9,n:'51'},{rank:null,n:'1'}]);
 expect((await db.session.query<{state:string}>("SELECT state FROM jobs WHERE kind='sourcing.callable_rank'")).rows).toEqual([{state:'done'}]);
 expect(await source.find(db.session,now)).toEqual([]);
 expect((await db.session.query('SELECT id FROM firms')).rows).toHaveLength(0);
 // A week on, both rows have expired and the workspace is due again.
 expect((await source.find(db.session,new Date(Date.now()+8*86_400_000).toISOString())).map(j=>j.workspaceId)).toEqual([seed.alpha.workspaceId]);
 const composition={classifier:undefined,mail:undefined,send:undefined,research:{pageFetch:{providerKey:'test',fetchPages:vi.fn()}}};
 expect(registerHandlers(new HandlerRegistry(),composition).get('sourcing.callable_rank')).toBeDefined();
 expect(registerHandlers(new HandlerRegistry(),{...composition,research:undefined}).get('sourcing.callable_rank')).toBeUndefined();
 expect(workerDueWorkSources(workerSourceFlags(composition)).map(s=>s.name)).toContain('sourcing-callable-rank');
});
