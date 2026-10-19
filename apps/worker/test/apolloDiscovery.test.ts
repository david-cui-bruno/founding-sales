import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {runApolloDiscovery} from '@fss/domain/sourcing/apolloDiscovery.ts';
import {reserveApolloPage,lockApolloAccount} from '@fss/domain/sourcing/apolloAllowance.ts';
import {saveCandidate,listCandidates,deleteCandidate} from '@fss/domain/sourcing/candidates.ts';
import {candidateListSchema} from '@fss/contracts';
import {TABLE_RETENTION_COVERAGE} from '@fss/domain/retention/coverage.ts';
import {openHold} from '@fss/domain/policy/holds.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {enqueueJob} from '@fss/domain/jobs/jobStore.ts';
import {runOnce} from '../src/runner/jobRunner.ts';
import {apolloDiscoverySource} from '../src/handlers/sourcingDiscovery.ts';
import {registerHandlers,workerDueWorkSources,workerSourceFlags} from '../src/bootstrap/main.ts';
import {apolloDiscoveryConfigureCommand} from '../src/tools/fss/apolloDiscoveryConfigure.ts';
import {apolloSearch} from '../src/sourcing/apolloSearch.ts';

let db:TestDatabase,seed:TwoWorkspaces;
const binding={accountRef:'exclusive-account-1',keyRef:'scoped-key-1'};
const launch={launchedBy:'arn:aws:iam::123456789012:user/operator',taskArn:'arn:aws:ecs:us-east-1:123456789012:task/cluster/abc'};
beforeEach(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});
afterEach(async()=>db.drop());
const context=(session:SessionQueryable=db.session,workspace=seed.alpha.workspaceId)=>repositoryContext(workspaceScope(workspace,{kind:'system',component:'worker'}),session);
const options=(extra:Record<string,string>={})=>({
 '--action':'configure','--workspace-id':seed.alpha.workspaceId,'--account-ref':binding.accountRef,'--key-ref':binding.keyRef,'--enabled':'true',
 '--cycle-start':new Date(Date.now()-3600000).toISOString(),'--cycle-end':new Date(Date.now()+30*86400000).toISOString(),
 '--verified-at':new Date(Date.now()-1000).toISOString(),'--exclusive-attested-at':new Date(Date.now()-1000).toISOString(),
 '--prior-used':'0','--exclusive-account-confirmed':'true','--key-account-binding-confirmed':'true','--free-plan-no-trial-no-paid-confirmed':'true','--external-usage-reconciled':'true',...extra,
});
const configure=(o:Record<string,string>=options(),session=db.session)=>apolloDiscoveryConfigureCommand({session,launch,options:o});
const ready=()=>db.session.query("UPDATE sourcing_apollo_allowances SET next_run_at=clock_timestamp()-interval '1 second'");
const snapshot=async(table:string)=>(await db.session.query(`SELECT * FROM ${table}`)).rows;
const organization={name:'Example PM',domain:'example.test',hqCity:'Dallas',hqState:'TX' as const,employeeCount:4};

it('is held without allowance/binding and enforces audited exclusive Free-plan operator approval',async()=>{
 const discoverOrganizations=vi.fn(async()=>({ok:true as const,requestId:'local',returnedCount:0,organizations:[]}));
 await runApolloDiscovery(context(),{...binding,provider:{providerKey:'apollo_free',discoverOrganizations}});
 expect(discoverOrganizations).not.toHaveBeenCalled();
 expect(await apolloDiscoverySource().find(db.session,new Date().toISOString())).toEqual([]);
 expect(await apolloDiscoveryConfigureCommand({session:db.session,options:options()})).toMatchObject({ok:false,reason:'launcher_unknown'});
 for(const flag of ['--exclusive-account-confirmed','--key-account-binding-confirmed','--free-plan-no-trial-no-paid-confirmed','--external-usage-reconciled'])expect(await configure(options({[flag]:'false'}))).toMatchObject({ok:false,reason:'invalid_options'});
 expect(await configure(options({'--prior-used':'76'}))).toMatchObject({ok:false,reason:'invalid_options'});
 expect(await configure(options({'--verified-at':new Date(Date.now()+60000).toISOString()}))).toMatchObject({ok:false,reason:'cycle_not_current'});
 expect(await configure(options({'--verified-at':new Date(Date.now()-2*86400000).toISOString()}))).toMatchObject({ok:false,reason:'cycle_not_current'});
 expect(await configure(options({'--enabled':'false'}))).toMatchObject({ok:true});
 await runApolloDiscovery(context(),{...binding,provider:{providerKey:'apollo_free',discoverOrganizations}});
 expect(discoverOrganizations).not.toHaveBeenCalled();
 expect((await snapshot('audit_events')).some(row=>JSON.stringify(row).includes('globalVendorQuotaGuaranteed'))).toBe(true);
});

it('registers and schedules one independently metered page, strips contacts before storage and preserves strict older-client contracts',async()=>{
 expect(await configure()).toMatchObject({ok:true});
 await db.session.query('INSERT INTO sourcing_search_account(id,daily_used,monthly_used) VALUES(true,4,99)');
 const tavilyBefore=await snapshot('sourcing_search_account');
 const peer=await db.appRuntimeSession();
 const http=vi.fn(async()=>{
  expect((await peer.query('SELECT reserved FROM sourcing_apollo_allowances')).rows[0]).toEqual({reserved:1});
  expect((await peer.query('SELECT state FROM sourcing_apollo_attempts')).rows[0]).toEqual({state:'reserved'});
  return new Response(JSON.stringify({organizations:[{name:'Example PM',primary_domain:'example.test',city:'Dallas',state:'Texas',estimated_num_employees:4,phone:'ERASE-PHONE',people:[{email:'ERASE-EMAIL'}],description:'ERASE-DESCRIPTION'}]}));
 });
 const deps={...binding,provider:apolloSearch('fixture-key',{http})};
 const composition={classifier:undefined,mail:undefined,send:undefined,research:undefined,apolloDiscovery:deps};
 expect(registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined}).get('sourcing.discover')).toBeUndefined();
 const source=workerDueWorkSources(workerSourceFlags(composition)).find(source=>source.name==='apollo-discovery')!;
 const now=new Date().toISOString(),jobs=await source.find(db.session,now);
 expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({kind:'sourcing.discover',maxAttempts:1,payload:{provider:'apollo_free'}});
 for(const job of jobs)await enqueueJob(db.session,job);
 const registry=registerHandlers(new HandlerRegistry(),composition);
 expect(await runOnce(db.session,{registry,owner:'apollo-test',limit:5})).toMatchObject({failed:0});
 expect(http).toHaveBeenCalledTimes(1);
 const candidates=await snapshot('sourcing_candidates');
 expect(candidates).toHaveLength(1);expect(candidates[0]).toMatchObject({status:'needs_review',revision:1,payload:{firmName:'Example PM',signal:'fit_only',evidence:'Company discovery suggestion only. First-party verification required.'}});
 expect(await snapshot('sourcing_search_account')).toEqual(tavilyBefore);
 for(const table of ['firms','contacts','sourcing_admissions','sourcing_discovery_attempts','sourcing_discovery_hits'])expect(await snapshot(table)).toEqual([]);
 const listed=await listCandidates(context(),{status:'needs_review',offset:0});
 expect(listed.ok).toBe(true);if(listed.ok)expect(candidateListSchema.safeParse(listed.value).success).toBe(true);
 for(const table of ['sourcing_candidates','sourcing_apollo_candidate_origins','sourcing_apollo_attempts','audit_events','jobs'])expect(JSON.stringify(await snapshot(table))).not.toContain('ERASE-');
 expect((await snapshot('sourcing_apollo_attempts'))[0]).toMatchObject({state:'complete',returned_count:1,created_count:1});
 expect(await apolloDiscoverySource({...binding,keyRef:'wrong-key'}).find(db.session,now)).toEqual([]);
});

it('serializes concurrent workers, includes prior usage and never spends credit 76 or resets a replayed cycle',async()=>{
 const o=options({'--prior-used':'73'});expect(await configure(o)).toMatchObject({ok:true});
 const sessions=await Promise.all(Array.from({length:8},()=>db.appRuntimeSession()));
 const discoverOrganizations=vi.fn(async()=>({ok:true as const,requestId:'local',returnedCount:100,organizations:[]}));
 const deps={...binding,provider:{providerKey:'apollo_free' as const,discoverOrganizations}};
 for(let n=0;n<3;n++){
  await ready();await Promise.all(sessions.map(session=>runApolloDiscovery(context(session),deps)));
 }
 expect(discoverOrganizations).toHaveBeenCalledTimes(2);
 expect((await snapshot('sourcing_apollo_allowances'))[0]).toMatchObject({starting_used:73,reserved:2});
 expect(await configure(o)).toMatchObject({ok:true});
 expect(await configure({...o,'--prior-used':'0'})).toMatchObject({ok:false,reason:'cycle_replay_conflict'});
 await ready();await runApolloDiscovery(context(),deps);expect(discoverOrganizations).toHaveBeenCalledTimes(2);
 expect(await snapshot('sourcing_apollo_attempts')).toHaveLength(2);
});

it('enforces the full 75-credit cap with committed real-PG reservations and distinct pages',async()=>{
 expect(await configure()).toMatchObject({ok:true});
 const session=await db.appRuntimeSession(),ctx=context(session);
 for(let n=0;n<75;n++){
  await ready();const attempt=await withTransaction(session,()=>reserveApolloPage(ctx,binding));
  expect(attempt).toMatchObject({region:'TX',page:n+1});
  await session.query("UPDATE sourcing_apollo_attempts SET state='complete',returned_count=100 WHERE id=$1",[attempt!.id]);
 }
 await ready();expect(await withTransaction(session,()=>reserveApolloPage(ctx,binding))).toBeNull();
 expect((await snapshot('sourcing_apollo_allowances'))[0]).toMatchObject({starting_used:0,reserved:75});
 expect(await snapshot('sourcing_apollo_attempts')).toHaveLength(75);
});

it('rejects overlapping account cycles and cross-workspace reuse under concurrent setup',async()=>{
 const o=options(),peer=await db.appRuntimeSession();
 const results=await Promise.all([configure(o),configure({...o,'--workspace-id':seed.beta.workspaceId,'--cycle-start':new Date(Date.now()-1800000).toISOString()},peer)]);
 expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>!r.ok)).toHaveLength(1);
 expect(await snapshot('sourcing_apollo_allowances')).toHaveLength(1);
 const owner=String((await snapshot('sourcing_apollo_allowances'))[0]!['workspace_id']);
 const other=owner===seed.alpha.workspaceId?seed.beta.workspaceId:seed.alpha.workspaceId;
 expect(await withTransaction(peer,()=>reserveApolloPage(context(peer,other),binding))).toBeNull();
 expect(await configure({...o,'--cycle-start':new Date(Date.now()+31*86400000).toISOString(),'--cycle-end':new Date(Date.now()+61*86400000).toISOString()})).toMatchObject({ok:false,reason:'cycle_not_current'});
});

it('halts failed or unknown dispatches, counts them spent, and conserves them across restarts and operator replay',async()=>{
 const o=options();expect(await configure(o)).toMatchObject({ok:true});
 await db.session.query('INSERT INTO sourcing_search_account(id,daily_used,monthly_used) VALUES(true,2,40)');
 const tavilyBefore=await snapshot('sourcing_search_account');
 const discoverOrganizations=vi.fn(async()=>{throw new Error('ERASE-TRANSPORT-SECRET');});
 const deps={...binding,provider:{providerKey:'apollo_free' as const,discoverOrganizations}};
 await runApolloDiscovery(context(),deps);await ready();await runApolloDiscovery(context(await db.appRuntimeSession()),deps);
 expect(discoverOrganizations).toHaveBeenCalledTimes(1);
 expect((await snapshot('sourcing_apollo_allowances'))[0]).toMatchObject({reserved:1,halted:true});
 expect(await configure(o)).toMatchObject({ok:false,reason:'account_halted'});
 const attempt=(await snapshot('sourcing_apollo_attempts'))[0]!;
 expect(attempt).toMatchObject({state:'failed',failure_code:'unavailable'});
 expect(JSON.stringify(await snapshot('audit_events'))).not.toContain('ERASE-');
 expect(await configure({'--action':'reconcile','--workspace-id':seed.alpha.workspaceId,'--account-ref':binding.accountRef,'--key-ref':binding.keyRef,'--attempt-id':String(attempt['id']),'--count-spent-confirmed':'true'})).toMatchObject({ok:true,value:{countedSpent:true,haltPreserved:true}});
 expect(await configure(o)).toMatchObject({ok:false,reason:'account_halted'});
 expect((await snapshot('sourcing_apollo_allowances'))[0]).toMatchObject({reserved:1,halted:true,enabled:false});
 expect(await snapshot('sourcing_search_account')).toEqual(tavilyBefore);
});

it('treats abandoned reservations as unknown, never retries their page and blocks a new cycle until reconciliation',async()=>{
 expect(await configure()).toMatchObject({ok:true});
 const attempt=await withTransaction(db.session,()=>reserveApolloPage(context(),binding));expect(attempt).not.toBeNull();
 await db.session.query("UPDATE sourcing_apollo_attempts SET reserved_at=clock_timestamp()-interval '3 minutes'");
 await ready();expect(await withTransaction(db.session,()=>reserveApolloPage(context(),binding))).toBeNull();
 expect((await snapshot('sourcing_apollo_attempts'))[0]).toMatchObject({state:'unknown'});
 // Model the old real billing cycle ending, not a runtime calendar/counter reset.
 await db.session.query("UPDATE sourcing_apollo_allowances SET cycle_start=clock_timestamp()-interval '31 days',cycle_end=clock_timestamp()-interval '1 day',verified_at=clock_timestamp()-interval '2 days',exclusive_attested_at=clock_timestamp()-interval '2 days'");
 expect(await configure()).toMatchObject({ok:false,reason:'prior_attempt_unresolved'});
 expect(await configure({'--action':'reconcile','--workspace-id':seed.alpha.workspaceId,'--account-ref':binding.accountRef,'--key-ref':binding.keyRef,'--attempt-id':attempt!.id,'--count-spent-confirmed':'true'})).toMatchObject({ok:true});
 expect(await configure(options({'--prior-used':'7'}))).toMatchObject({ok:true});
 const rows=await snapshot('sourcing_apollo_allowances');expect(rows).toHaveLength(2);
 expect(rows.find(r=>r['halted'])).toMatchObject({reserved:1,enabled:false});
 expect(rows.find(r=>!r['halted'])).toMatchObject({starting_used:7,reserved:0});
});

it.each(['advisory','row'] as const)('checks the actual post-%s-lock database clock, not transaction start time',async lock=>{
 expect(await configure()).toMatchObject({ok:true});
 const holder=await db.appRuntimeSession(),waiter=await db.appRuntimeSession();
 await holder.query('BEGIN');
 if(lock==='advisory')await lockApolloAccount(holder,binding.accountRef);
 else await holder.query('SELECT id FROM sourcing_apollo_allowances FOR UPDATE');
 await holder.query("UPDATE sourcing_apollo_allowances SET cycle_end=clock_timestamp()+interval '150 milliseconds'");
 const waiting=withTransaction(waiter,()=>reserveApolloPage(context(waiter),binding));
 await holder.query('SELECT pg_sleep(0.25)');await holder.query('COMMIT');
 expect(await waiting).toBeNull();expect(await snapshot('sourcing_apollo_attempts')).toEqual([]);
});

it('dedupes domain and names, skips incomplete headquarters, progresses TX then RI/MA, and erases provenance without refund',async()=>{
 expect(await configure()).toMatchObject({ok:true});
 await saveCandidate(context(),{firmName:'Already PM',website:'https://already.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:'https://already.test/',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Fixture'});
 const discoverOrganizations=vi.fn(async()=>({ok:true as const,requestId:'ERASE-VENDOR-REQUEST',returnedCount:5,organizations:[organization,{...organization,name:'Another name'},{...organization,name:'Already PM',domain:'other.test'},{...organization,name:'No HQ',domain:'nohq.test',hqCity:null},{...organization,name:'Wrong region',domain:'wrong.test',hqState:'RI' as const}]}));
 const deps={...binding,provider:{providerKey:'apollo_free' as const,discoverOrganizations}};
 await runApolloDiscovery(context(),deps);
 expect(await snapshot('sourcing_candidates')).toHaveLength(2);
 const origin=(await snapshot('sourcing_apollo_candidate_origins'))[0]!;
 expect(await snapshot('sourcing_apollo_candidate_origins')).toHaveLength(1);
 await ready();discoverOrganizations.mockResolvedValueOnce({ok:true,requestId:'local',returnedCount:0,organizations:[]});await runApolloDiscovery(context(),deps);
 await ready();discoverOrganizations.mockResolvedValueOnce({ok:true,requestId:'local',returnedCount:0,organizations:[]});await runApolloDiscovery(context(),deps);
 await ready();await runApolloDiscovery(context(),deps);
 expect(discoverOrganizations).toHaveBeenCalledTimes(3);
 expect(await apolloDiscoverySource(binding).find(db.session,new Date().toISOString())).toEqual([]);
 expect((await snapshot('sourcing_apollo_attempts')).map(row=>row['region'])).toEqual(['TX','RI','MA']);
 expect(await deleteCandidate(context(),{id:String(origin['candidate_id']),expectedRevision:1})).toMatchObject({ok:true});
 expect(await snapshot('sourcing_apollo_candidate_origins')).toHaveLength(0);
 expect((await snapshot('sourcing_apollo_allowances'))[0]).toMatchObject({reserved:3});
 expect(TABLE_RETENTION_COVERAGE['sourcing_apollo_candidate_origins']?.dispositions).toContain('deletion_removes');
 expect(TABLE_RETENTION_COVERAGE['sourcing_apollo_attempts']?.dispositions).toContain('retained');
});

it('checks key binding, administrator, research disable and after-wait disable before publication',async()=>{
 expect(await configure()).toMatchObject({ok:true});
 const discoverOrganizations=vi.fn(async()=>({ok:true as const,requestId:'local',returnedCount:1,organizations:[organization]}));
 const deps={...binding,provider:{providerKey:'apollo_free' as const,discoverOrganizations}};
 await runApolloDiscovery(context(),{...deps,keyRef:'wrong-key'});
 const salesperson=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.salesperson.userId,role:'salesperson'}),db.session);
 await runApolloDiscovery(salesperson,deps);
 await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,false)',[seed.alpha.workspaceId]);
 await runApolloDiscovery(context(),deps);expect(discoverOrganizations).not.toHaveBeenCalled();
 await db.session.query('UPDATE research_settings SET enabled=true');
 discoverOrganizations.mockImplementationOnce(async()=>{
  await configure({'--action':'disable','--workspace-id':seed.alpha.workspaceId,'--account-ref':binding.accountRef,'--key-ref':binding.keyRef},await db.appRuntimeSession());
  return {ok:true as const,requestId:'local',returnedCount:1,organizations:[organization]};
 });
 await runApolloDiscovery(context(),deps);
 expect(await snapshot('sourcing_candidates')).toEqual([]);
 expect((await snapshot('sourcing_apollo_attempts'))[0]).toMatchObject({state:'complete',returned_count:1,created_count:0});
 expect((await snapshot('sourcing_apollo_allowances'))[0]).toMatchObject({reserved:1,enabled:false});
});

it('refuses concurrent reuse of one operator-bound key reference under different account references',async()=>{
 const o=options(),peer=await db.appRuntimeSession();
 const outcomes=await Promise.all([configure(o),configure({...o,'--account-ref':'other-account','--workspace-id':seed.beta.workspaceId},peer)]);
 expect(outcomes.filter(outcome=>outcome.ok)).toHaveLength(1);
 expect(outcomes.find(outcome=>!outcome.ok)).toMatchObject({reason:'key_binding_conflict'});
 expect(await snapshot('sourcing_apollo_allowances')).toHaveLength(1);
});

it('conservatively spends and halts an adapter response that violates the source-page bound',async()=>{
 expect(await configure()).toMatchObject({ok:true});
 const discoverOrganizations=vi.fn(async()=>({ok:true as const,requestId:'local',returnedCount:101,organizations:[]}));
 await runApolloDiscovery(context(),{...binding,provider:{providerKey:'apollo_free',discoverOrganizations}});
 expect((await snapshot('sourcing_apollo_allowances'))[0]).toMatchObject({reserved:1,halted:true});
 expect((await snapshot('sourcing_apollo_attempts'))[0]).toMatchObject({state:'failed',failure_code:'invalid_response'});
 expect(await snapshot('sourcing_candidates')).toEqual([]);
});

it('does not dispatch through a research hold or publish a result reconciled while the provider waits',async()=>{
 expect(await configure()).toMatchObject({ok:true});
 const ctx=context();
 await withTransaction(db.session,()=>openHold(ctx,{scopeKind:'workspace',reasonCode:'scoped_pause',blockedActionKinds:['research'],sourceEventKind:'fixture'}));
 const discoverOrganizations=vi.fn(async()=>({ok:true as const,requestId:'local',returnedCount:1,organizations:[organization]}));
 await runApolloDiscovery(ctx,{...binding,provider:{providerKey:'apollo_free',discoverOrganizations}});
 expect(discoverOrganizations).not.toHaveBeenCalled();
 expect(await apolloDiscoverySource(binding).find(db.session,new Date().toISOString())).toEqual([]);
 await db.session.query('UPDATE active_holds SET released_at=clock_timestamp()');
 const peer=await db.appRuntimeSession();
 discoverOrganizations.mockImplementationOnce(async()=>{
  const id=String((await snapshot('sourcing_apollo_attempts'))[0]!['id']);
  expect(await configure({'--action':'reconcile','--workspace-id':seed.alpha.workspaceId,'--account-ref':binding.accountRef,'--key-ref':binding.keyRef,'--attempt-id':id,'--count-spent-confirmed':'true'},peer)).toMatchObject({ok:true});
  return {ok:true,requestId:'local',returnedCount:1,organizations:[organization]};
 });
 await runApolloDiscovery(ctx,{...binding,provider:{providerKey:'apollo_free',discoverOrganizations}});
 expect(await snapshot('sourcing_candidates')).toEqual([]);
 expect((await snapshot('sourcing_apollo_allowances'))[0]).toMatchObject({reserved:1,enabled:false,halted:true});
 expect((await snapshot('sourcing_apollo_attempts'))[0]).toMatchObject({state:'failed',failure_code:'operator_reconciled_spent'});
});
