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
 expect((await db.session.query("SELECT id FROM jobs WHERE kind='sourcing.qualify'")).rows).toHaveLength(0);
 expect((await db.session.query('SELECT id FROM sourcing_qualification_runs')).rows).toHaveLength(0);
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
 expect((await db.session.query('SELECT id FROM sourcing_qualification_runs WHERE candidate_id=$1',[firmHit.candidate_id])).rows).toHaveLength(0);
});

it('looks beyond duplicate and directory hits but drafts at most five new candidates per run without research',async()=>{
 await db.session.query('DELETE FROM sourcing_discovery_hits');await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await db.session.query('UPDATE sourcing_search_account SET halted=false,daily_used=0,monthly_used=0');
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now(),enabled=true');
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 const hits=[
  ...Array.from({length:5},(_,i)=>({url:`https://www.allpropertymanagement.com/area-${i}`,title:'Directory',snippet:'Directory'})),
  ...Array.from({length:7},(_,i)=>({url:`https://yield-${i}.test/`,title:`Yield Realty ${i}`,snippet:'Residential management'})),
 ];
 const provider={providerKey:'tavily_basic',discover:async()=>({ok:true as const,credits:1,requestId:'yield',hits})};
 await runDiscovery(ctx,provider);
 const rows=async()=>(await db.session.query<{candidate_id:string|null}>("SELECT candidate_id FROM sourcing_discovery_hits WHERE workspace_id=$1 AND source_url LIKE 'https://yield-%'",[workspaceId])).rows;
 expect((await rows()).filter(r=>r.candidate_id)).toHaveLength(5);
 expect(await rows()).toHaveLength(7);
 expect((await db.session.query("SELECT count(*)::int AS count FROM sourcing_qualification_runs q JOIN sourcing_candidates c ON c.id=q.candidate_id WHERE c.workspace_id=$1 AND c.payload->>'website' LIKE 'https://yield-%'",[workspaceId])).rows[0]).toEqual({count:0});
 // Previously seen, unprocessed hits remain available when the next day's search returns them.
 await db.session.query('UPDATE sourcing_discovery_attempts SET day=day-1');
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await runDiscovery(ctx,provider);
 expect((await rows()).filter(r=>r.candidate_id)).toHaveLength(7);
 expect((await db.session.query('SELECT daily_used FROM sourcing_search_account')).rows[0]).toEqual({daily_used:2});
});

it('defaults to one daily slot and preserves the original next-day schedule',async()=>{
 await db.session.query('DELETE FROM sourcing_discovery_hits');await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await db.session.query('UPDATE sourcing_search_account SET halted=false,daily_used=0,monthly_used=0');
 await db.session.query('UPDATE sourcing_discovery_settings SET searches_per_day=1,next_run_at=now()');
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 let calls=0;const provider={providerKey:'tavily_basic',discover:async()=>{calls++;return {ok:true as const,credits:1,requestId:'default',hits:[]};}};
 await runDiscovery(ctx,provider);
 expect((await db.session.query('SELECT slot FROM sourcing_discovery_attempts')).rows).toEqual([{slot:0}]);
 expect((await db.session.query("SELECT next_run_at>now()+interval '23 hours 59 minutes' AS tomorrow FROM sourcing_discovery_settings WHERE workspace_id=$1",[workspaceId])).rows[0]).toEqual({tomorrow:true});
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await runDiscovery(ctx,provider);expect(calls).toBe(1);
});

it('paces opt-in slots, serializes same-workspace dispatch and cannot exceed ten daily searches',async()=>{
 await db.session.query('DELETE FROM sourcing_discovery_hits');await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await db.session.query('UPDATE sourcing_search_account SET halted=false,daily_used=0,monthly_used=0');
 await db.session.query('UPDATE sourcing_discovery_settings SET searches_per_day=10,next_run_at=now() WHERE workspace_id=$1',[workspaceId]);
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 const peer=repositoryContext(ctx.scope,await db.appRuntimeSession());
 let calls=0;const provider={providerKey:'tavily_basic',discover:async()=>{calls++;return {ok:true as const,credits:1,requestId:`slot-${calls}`,hits:[]};}};
 await Promise.all([runDiscovery(ctx,provider),runDiscovery(peer,provider)]);
 expect(calls).toBe(1);
 expect((await db.session.query("SELECT next_run_at BETWEEN now()+interval '143 minutes' AND now()+interval '145 minutes' AS paced FROM sourcing_discovery_settings WHERE workspace_id=$1",[workspaceId])).rows[0]).toEqual({paced:true});
 await runDiscovery(ctx,provider);expect(calls).toBe(1);
 for(let n=0;n<10;n++){
  await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now() WHERE workspace_id=$1',[workspaceId]);
  await runDiscovery(ctx,provider);
 }
 expect(calls).toBe(10);
 expect((await db.session.query('SELECT slot FROM sourcing_discovery_attempts WHERE workspace_id=$1 ORDER BY slot',[workspaceId])).rows).toEqual(Array.from({length:10},(_,slot)=>({slot})));
 expect((await db.session.query('SELECT daily_used,monthly_used FROM sourcing_search_account')).rows[0]).toEqual({daily_used:10,monthly_used:10});
 // UTC rollover opens a fresh slot, without refunding the still-current account period.
 await db.session.query('UPDATE sourcing_discovery_attempts SET day=day-1');
 await runDiscovery(ctx,provider);expect(calls).toBe(11);
 expect((await db.session.query('SELECT monthly_used FROM sourcing_search_account')).rows[0]).toEqual({monthly_used:11});
});

it('does not bypass a monthly account cap with an available workspace slot',async()=>{
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await db.session.query('UPDATE sourcing_search_account SET daily_used=0,monthly_used=600');
 let calls=0;await runDiscovery(repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session),{providerKey:'tavily_basic',discover:async()=>{calls++;throw new Error('must not call');}});
 expect(calls).toBe(0);
 expect((await db.session.query('SELECT monthly_used FROM sourcing_search_account')).rows[0]).toEqual({monthly_used:600});
});

it('enforces migration118 settings and slot constraints on actual inserts, including composite uniqueness',async()=>{
 const {randomUUID}=await import('node:crypto');
 for(const searches of [0,11]){
  await expect(db.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,searches_per_day) VALUES($1,$2)',[randomUUID(),searches])).rejects.toMatchObject({code:'23514',constraint:'sourcing_discovery_searches_per_day'});
 }
 const insert=(slot:number)=>db.session.query("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query,slot) VALUES($1,'constraint-fixture','fixture',$2)",[workspaceId,slot]);
 for(const slot of [-1,10])await expect(insert(slot)).rejects.toMatchObject({code:'23514',constraint:'sourcing_discovery_slot'});
 await db.session.query('DELETE FROM sourcing_discovery_attempts');
 await insert(0);await insert(1);
 await expect(insert(1)).rejects.toMatchObject({code:'23505',constraint:'sourcing_discovery_attempts_workspace_day_slot'});
 expect((await db.session.query('SELECT slot FROM sourcing_discovery_attempts ORDER BY slot')).rows).toEqual([{slot:0},{slot:1}]);
});

it('upgrades historical attempts to slot zero without activating throughput or resetting settings and account holds',async()=>{
 const {applyMigrations}=await import('../../db/migrationRunner.ts');
 const old=await createTestDatabase({throughVersion:117});
 try{
  const workspace=(await seedTwoWorkspaces(old.session)).alpha.workspaceId;
  await old.session.query('INSERT INTO sourcing_search_account(id,halted,daily_used,monthly_used) VALUES(true,true,7,42)');
  await old.session.query("INSERT INTO sourcing_discovery_settings(workspace_id,enabled,next_run_at,query_cursor,last_result) VALUES($1,true,'2026-10-20T00:00:00Z',4,'unavailable')",[workspace]);
  const attempt=(await old.session.query<{id:string}>("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query,state) VALUES($1,'historical','historical query','dispatched') RETURNING id",[workspace])).rows[0]!.id;
  await applyMigrations(old.session);
  expect((await old.session.query('SELECT enabled,next_run_at,query_cursor,last_result,searches_per_day FROM sourcing_discovery_settings')).rows).toEqual([{enabled:true,next_run_at:new Date('2026-10-20T00:00:00Z'),query_cursor:4,last_result:'unavailable',searches_per_day:1}]);
  expect((await old.session.query('SELECT id,slot,state,query FROM sourcing_discovery_attempts')).rows).toEqual([{id:attempt,slot:0,state:'dispatched',query:'historical query'}]);
  expect((await old.session.query('SELECT halted,daily_used,monthly_used FROM sourcing_search_account')).rows).toEqual([{halted:true,daily_used:7,monthly_used:42}]);
 }finally{await old.drop();}
});
