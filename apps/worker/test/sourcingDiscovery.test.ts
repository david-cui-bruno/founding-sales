import {discoveryConfigureCommand} from '../src/tools/fss/discoveryConfigure.ts';
import {afterAll,beforeAll,it,expect,vi} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {enqueueJob} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {runOnce} from '../src/runner/jobRunner.ts';
import {sourcingDiscoveryHandler,sourcingDiscoverySource} from '../src/handlers/sourcingDiscovery.ts';
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase();});afterAll(async()=>{await db.drop();});
it('runs a scheduled search outside a rollbackable handler transaction and creates only unverified candidates',async()=>{
 const seed=await seedTwoWorkspaces(db.session);
 await db.session.query('INSERT INTO sourcing_search_account(id) VALUES(true)');
 await db.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,enabled) VALUES($1,true)',[seed.alpha.workspaceId]);
 await db.session.query("UPDATE sourcing_discovery_settings SET next_run_at=now()-interval '1 minute'");
 const now=new Date().toISOString();
 expect(await sourcingDiscoverySource(false).find(db.session,now)).toEqual([]);
 for(const job of await sourcingDiscoverySource(true).find(db.session,now))await enqueueJob(db.session,job);
 const peer=await db.appRuntimeSession();
 const discover=vi.fn(async()=>{
  expect((await peer.query('SELECT * FROM sourcing_discovery_attempts')).rows).toHaveLength(1);
  return {ok:true as const,credits:1,requestId:'fixture',hits:[{url:'https://example.test/',title:'Example PM',snippet:'Residential management'}]};
 });
 const registry=new HandlerRegistry().register(sourcingDiscoveryHandler({providerKey:'tavily_basic',discover}));
 expect((await runOnce(db.session,{registry,owner:'discovery-test',limit:5})).failed).toBe(0);
 expect(discover).toHaveBeenCalledTimes(1);
 expect((await db.session.query('SELECT status,payload FROM sourcing_candidates')).rows[0]).toMatchObject({status:'needs_review',payload:{signal:'fit_only',discoveryQuery:'Dallas Fort Worth residential property management'}});
 expect((await db.session.query('SELECT id FROM firms')).rows).toHaveLength(0);
 expect(await sourcingDiscoverySource(true).find(db.session,new Date().toISOString())).toEqual([]);
});

it('requires an audited launch to configure; repeated configuration cannot reset quotas or a halt',async()=>{
 const workspace=(await db.session.query<{workspace_id:string}>('SELECT workspace_id FROM sourcing_discovery_settings LIMIT 1')).rows[0]!.workspace_id;
 const options={'--workspace-id':workspace,'--enabled':'false','--prior-day':'2026-10-05','--prior-day-used':'0','--prior-month-used':'0'};
 expect(await discoveryConfigureCommand({session:db.session,options})).toMatchObject({ok:false,reason:'launcher_unknown'});
 await db.session.query('UPDATE sourcing_search_account SET halted=true,daily_used=20,monthly_used=20');
 expect(await discoveryConfigureCommand({session:db.session,options,launch:{launchedBy:'arn:aws:iam::123456789012:user/operator',taskArn:'arn:aws:ecs:us-east-1:123456789012:task/cluster/abc'}})).toMatchObject({ok:true});
 expect((await db.session.query('SELECT halted,daily_used,monthly_used FROM sourcing_search_account')).rows[0]).toMatchObject({halted:true,daily_used:20,monthly_used:20});
 expect((await db.session.query('SELECT enabled FROM sourcing_discovery_settings')).rows[0]).toMatchObject({enabled:false});
});
it('revisits deferred work in a later hour without retrying any dispatched search',async()=>{
 await db.session.query("UPDATE sourcing_discovery_settings SET enabled=true,next_run_at=now()-interval '2 days'");
 const first=await sourcingDiscoverySource(true).find(db.session,new Date().toISOString());
 const later=await sourcingDiscoverySource(true).find(db.session,new Date(Date.now()+3_600_000).toISOString());
 expect(first).toHaveLength(1);expect(later).toHaveLength(1);
 expect(first[0]!.idempotencyKey).not.toBe(later[0]!.idempotencyKey);
});
