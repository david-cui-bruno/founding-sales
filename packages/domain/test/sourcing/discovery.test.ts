import {saveCandidate,reviewCandidate} from '../../sourcing/candidates.ts';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {runDiscovery} from '../../sourcing/discovery.ts';
let db:TestDatabase;let workspaceId:string;let otherWorkspaceId:string;
beforeAll(async()=>{db=await createTestDatabase();const seeded=await seedTwoWorkspaces(db.session);workspaceId=seeded.alpha.workspaceId;otherWorkspaceId=seeded.beta.workspaceId;});
afterAll(async()=>{await db.drop();});
it('reserves durably before external work; replay does not call again',async()=>{
 await db.session.query('INSERT INTO sourcing_search_account(id) VALUES(true)');
 await db.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,enabled) VALUES($1,true)',[workspaceId]);
 const context=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 let calls=0;
 const provider={providerKey:'tavily_basic',discover:async()=>{calls++;
  expect((await (await db.appRuntimeSession()).query('SELECT id FROM sourcing_discovery_attempts')).rows).toHaveLength(1);
  return {ok:true as const,credits:1,requestId:'test',hits:[{url:'https://example.test/',title:'Example PM',snippet:'Property management'}]};}};
 await runDiscovery(context,provider);await runDiscovery(context,provider);
 expect(calls).toBe(1);
 expect((await db.session.query('SELECT * FROM sourcing_discovery_hits')).rows).toHaveLength(1);
 expect((await db.session.query("SELECT id FROM jobs WHERE kind='sourcing.qualify'")).rows).toHaveLength(1);
 expect((await db.session.query('SELECT id FROM sourcing_qualification_runs')).rows).toHaveLength(1);
});
it('keeps failures charged and does not retry a dispatched request',async()=>{
 await db.session.query('DELETE FROM sourcing_discovery_hits');await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await db.session.query("UPDATE sourcing_discovery_settings SET next_run_at=now(),enabled=true");
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 let calls=0;const provider={providerKey:'tavily_basic',discover:async()=>{calls++;throw new Error('network');}};
 await runDiscovery(ctx,provider);await runDiscovery(ctx,provider);expect(calls).toBe(1);
 expect((await db.session.query('SELECT daily_used FROM sourcing_search_account')).rows[0]).toMatchObject({daily_used:2});
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await runDiscovery(ctx,provider);
 expect(calls).toBe(1);
 expect((await db.session.query('SELECT last_result FROM sourcing_discovery_settings WHERE workspace_id=$1',[workspaceId])).rows[0]).toEqual({last_result:'unavailable'});
 expect((await db.session.query("SELECT detail FROM audit_events WHERE action='sourcing.discovery_failed' AND workspace_id=$1",[workspaceId])).rows).toEqual([{detail:{code:'unavailable',provider:'tavily_basic'}}]);
});
it('stops at the shared ceiling without sending, and an absent account fails closed',async()=>{
 await db.session.query('DELETE FROM sourcing_discovery_attempts');await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await db.session.query('UPDATE sourcing_search_account SET daily_used=20,halted=false');
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 const provider={providerKey:'tavily_basic',discover:async()=>{throw new Error('must not call');}};
 await runDiscovery(ctx,provider);
 expect((await db.session.query('SELECT * FROM sourcing_discovery_attempts')).rows).toHaveLength(0);
 expect((await db.session.query('SELECT last_result FROM sourcing_discovery_settings')).rows[0]).toMatchObject({last_result:'quota_exhausted'});
});
it('disabled research prevents dispatch and unexpected usage halts the whole account',async()=>{
 await db.session.query('UPDATE sourcing_search_account SET daily_used=0');
 await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,false)',[workspaceId]);
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 let calls=0;const provider={providerKey:'tavily_basic',discover:async()=>{calls++;return {ok:true as const,credits:2,requestId:'bad',hits:[]};}};
 await runDiscovery(ctx,provider);expect(calls).toBe(0);
 await db.session.query('UPDATE research_settings SET enabled=true');await runDiscovery(ctx,provider);expect(calls).toBe(1);
 expect((await db.session.query('SELECT halted FROM sourcing_search_account')).rows[0]).toMatchObject({halted:true});
});
it('does not resurface a dismissed candidate on repeated discovery of the same source',async()=>{
 await db.session.query('DELETE FROM research_settings');await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await db.session.query('UPDATE sourcing_search_account SET halted=false,daily_used=0,monthly_used=0');
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 const provider={providerKey:'tavily_basic',discover:async()=>({ok:true as const,credits:1,requestId:'test',hits:[{url:'https://example.test/',title:'Example PM',snippet:'Property management'}]})};
 await runDiscovery(ctx,provider);
 await db.session.query("UPDATE sourcing_candidates SET status='dismissed'");
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await db.session.query("UPDATE sourcing_discovery_attempts SET day=day-1");
 await runDiscovery(ctx,provider);
 expect((await db.session.query("SELECT id FROM sourcing_candidates WHERE status='needs_review'")).rows).toHaveLength(0);
});

it('serializes account quota across concurrent workspaces',async()=>{
 await db.session.query('DELETE FROM sourcing_discovery_hits');await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await db.session.query('UPDATE sourcing_search_account SET halted=false,daily_used=19,monthly_used=19');
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await db.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,enabled) VALUES($1,true)',[otherWorkspaceId]);
 let calls=0;const provider={providerKey:'tavily_basic',discover:async()=>{calls++;return {ok:true as const,credits:1,requestId:'parallel',hits:[]};}};
 await Promise.all([runDiscovery(repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session),provider),runDiscovery(repositoryContext(workspaceScope(otherWorkspaceId,{kind:'system',component:'worker'}),await db.appRuntimeSession()),provider)]);
 expect(calls).toBe(1);expect((await db.session.query('SELECT daily_used FROM sourcing_search_account')).rows[0]).toMatchObject({daily_used:20});
});
it('halts after a crash leaves an old dispatch whose usage is unknown',async()=>{
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await db.session.query('UPDATE sourcing_search_account SET halted=false,daily_used=0');
 await db.session.query("UPDATE sourcing_discovery_attempts SET state='dispatched',created_at=now()-interval '3 minutes'");
 let calls=0;await runDiscovery(repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session),{providerKey:'tavily_basic',discover:async()=>{calls++;throw new Error('must not send');}});
 expect(calls).toBe(0);expect((await db.session.query('SELECT halted FROM sourcing_search_account')).rows[0]).toMatchObject({halted:true});
});

it('respects a dismissed manual candidate even when the search title and query area differ',async()=>{
 await db.session.query('DELETE FROM sourcing_discovery_hits');await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await db.session.query('UPDATE sourcing_search_account SET halted=false,daily_used=0,monthly_used=0');
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 const saved=await saveCandidate(ctx,{firmName:'Original local name',website:'https://manual.example.test/',locality:'Boston',region:'MA',signal:'fit_only',sourceUrl:'https://manual.example.test/',evidence:'Original',preparedBy:'Manual',observedOn:'2026-10-01'});if(!saved.ok)throw new Error('fixture');
 await reviewCandidate(ctx,{id:saved.value.id,expectedRevision:1,status:'dismissed'});
 await runDiscovery(ctx,{providerKey:'tavily_basic',discover:async()=>({ok:true,credits:1,requestId:'manual-duplicate',hits:[{url:'https://manual.example.test/',title:'Different search title',snippet:'Raw excerpt'}]})});
 expect((await db.session.query("SELECT status FROM sourcing_candidates WHERE payload->>'sourceUrl'='https://manual.example.test/'")).rows).toEqual([{status:'dismissed'}]);
 expect((await db.session.query('SELECT native_result FROM sourcing_discovery_hits')).rows[0]).toMatchObject({native_result:{snippet:'Raw excerpt',title:'Different search title'}});
});
it('rolls UTC periods without refunding usage within a period',async()=>{
 await db.session.query('DELETE FROM sourcing_discovery_hits');await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await db.session.query("UPDATE sourcing_search_account SET halted=false,daily_used=20,monthly_used=600,day=current_date-40,month=current_date-40");
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await runDiscovery(repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session),{providerKey:'tavily_basic',discover:async()=>({ok:true,credits:1,requestId:'rollover',hits:[]})});
 expect((await db.session.query('SELECT daily_used,monthly_used FROM sourcing_search_account')).rows[0]).toMatchObject({daily_used:1,monthly_used:1});
});
it('does not call a provider without a reconciled shared account',async()=>{
 await db.session.query('DELETE FROM sourcing_search_account');await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 let calls=0;await runDiscovery(repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session),{providerKey:'tavily_basic',discover:async()=>{calls++;throw new Error('must not call');}});
 expect(calls).toBe(0);expect((await db.session.query('SELECT last_result FROM sourcing_discovery_settings WHERE workspace_id=$1',[workspaceId])).rows[0]).toMatchObject({last_result:'account_not_configured'});
});

it('preserves raw directory hits without creating firms and cleans candidate titles before qualification',async()=>{
 await db.session.query('INSERT INTO sourcing_search_account(id) VALUES(true) ON CONFLICT DO NOTHING');
 await db.session.query('DELETE FROM sourcing_discovery_hits');await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await db.session.query('DELETE FROM research_settings');
 await db.session.query('UPDATE sourcing_search_account SET halted=false,daily_used=0,monthly_used=0');
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now(),enabled=true');
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 await runDiscovery(ctx,{providerKey:'tavily_basic',discover:async()=>({ok:true,credits:1,requestId:'identity-fixture',hits:[
  {url:'https://www.allpropertymanagement.com/property-management/ri/providence',title:'Top Property Managers | APM',snippet:'Directory'},
  {url:'https://rentprov-fixture.test/',title:'RentProv Realty - Rentals, Sales, and Property Management',snippet:'Residential management'},
 ]})});
 const hits=(await db.session.query<{source_url:string;candidate_id:string|null;native_result:unknown}>("SELECT source_url,candidate_id,native_result FROM sourcing_discovery_hits WHERE workspace_id=$1 ORDER BY source_url",[workspaceId])).rows;
 expect(hits).toHaveLength(2);
 expect(hits.find(h=>String(h.source_url).includes('allpropertymanagement'))?.candidate_id).toBeNull();
 const firmHit=hits.find(h=>String(h.source_url).includes('rentprov-fixture'))!;
 expect(firmHit.native_result).toMatchObject({title:'RentProv Realty - Rentals, Sales, and Property Management'});
 expect((await db.session.query('SELECT payload FROM sourcing_candidates WHERE id=$1',[firmHit.candidate_id])).rows[0]).toMatchObject({payload:{firmName:'RentProv Realty'}});
 expect((await db.session.query('SELECT id FROM sourcing_qualification_runs WHERE candidate_id=$1',[firmHit.candidate_id])).rows).toHaveLength(1);
});
