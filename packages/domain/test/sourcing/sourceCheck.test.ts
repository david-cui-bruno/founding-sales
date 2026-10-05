import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { saveCandidate, listCandidates, reviewCandidate, deleteCandidate } from '../../sourcing/candidates.ts';

import {requestSourceCheck,runSourceCheck} from '../../sourcing/sourceCheck.ts';

let database: TestDatabase;
let seeded: TwoWorkspaces;
const draft = {
  firmName: 'Example PM', website: 'https://example.test/dallas/', locality: 'Dallas', region: 'TX' as const,
  signal: 'responsibility_overlap' as const, evidence: '<script>untrusted</script> Manager handles maintenance.',
  sourceUrl: 'https://example.test/team', observedOn: '2026-10-01', preparedBy: 'Manual research',
};
const context = (workspace: 'alpha' | 'beta' = 'alpha', role: 'admin' | 'salesperson' = 'admin') => {
  const who = seeded[workspace];
  return repositoryContext(workspaceScope(who.workspaceId, {kind:'user',userId:who[role].userId,role}), database.session);
};
const save = async (input = draft) => withTransaction(database.session, async () => saveCandidate(context(), input));
beforeAll(async () => { database = await createTestDatabase(); seeded = await seedTwoWorkspaces(database.session); });
beforeEach(async () => { await database.session.query('DELETE FROM sourcing_candidates'); await database.session.query("DELETE FROM jobs WHERE kind='sourcing.check'");await database.session.query('DELETE FROM research_settings');await database.session.query('DELETE FROM daily_counters'); });
afterAll(async () => { await database.drop(); });


it('queues a bounded check, deduplicates pending work and isolates admin/workspace access',async()=>{
 const saved=await save();if(!saved.ok)throw new Error('save');const input={id:saved.value.id,expectedRevision:1};
 expect(await requestSourceCheck(context('beta'),input)).toMatchObject({ok:false,reason:'not_found'});
 expect(await requestSourceCheck(context('alpha','salesperson'),input)).toMatchObject({ok:false,reason:'admin_only'});
 const first=await withTransaction(database.session,()=>requestSourceCheck(context(),input));expect(first.ok).toBe(true);
 expect(await withTransaction(database.session,()=>requestSourceCheck(context(),{...input,expectedRevision:2}))).toMatchObject({ok:false,reason:'check_in_progress'});
 const rows=await database.session.query("SELECT payload,max_attempts FROM jobs WHERE kind='sourcing.check'");expect(rows.rows.length).toBe(1);expect(JSON.stringify(rows.rows)).not.toContain('example.test');
});
it('records a source snapshot once, preserves it on failure, and ignores stale or deleted work',async()=>{
 const saved=await save();if(!saved.ok)throw new Error('save');const id=saved.value.id;
 await withTransaction(database.session,()=>requestSourceCheck(context(),{id,expectedRevision:1}));
 const job=await database.session.query<{payload:{candidateId:string;checkId:string}}>("SELECT payload FROM jobs WHERE kind='sourcing.check' ORDER BY created_at DESC LIMIT 1");const payload=job.rows[0]!.payload;
 const fetcher={providerKey:'test',fetchPages:async()=>({ok:true as const,costCents:0,value:{pages:[{url:draft.sourceUrl,contentHash:'a'.repeat(64),contentType:'text/html',body:new TextEncoder().encode('<p>Manager handles maintenance.</p><script>secret()</script>'),retrievedAt:'2026-10-05T00:00:00Z',firstParty:true}],skipped:{}}})};
 await withTransaction(database.session,()=>runSourceCheck(context(),payload,fetcher));
 let list=await listCandidates(context(),{status:'needs_review',offset:0});expect(list).toMatchObject({value:{candidates:[{sourceCheck:{state:'checked',lastSuccess:{excerpt:'Manager handles maintenance.',quoteMatched:false}}}]}});
 await withTransaction(database.session,()=>runSourceCheck(context(),payload,{providerKey:'test',fetchPages:async()=>{throw new Error('must not fetch twice');}}));
 await withTransaction(database.session,()=>requestSourceCheck(context(),{id,expectedRevision:2}));
 const next=await database.session.query<{payload:{candidateId:string;checkId:string}}>("SELECT payload FROM jobs WHERE kind='sourcing.check' ORDER BY created_at DESC LIMIT 1");
 await withTransaction(database.session,()=>runSourceCheck(context(),next.rows[0]!.payload,{providerKey:'test',fetchPages:async()=>({ok:false as const,costCents:0,failureCode:'timeout'})}));
 list=await listCandidates(context(),{status:'needs_review',offset:0});expect(list).toMatchObject({value:{candidates:[{sourceCheck:{state:'unavailable',reason:'source_unavailable',lastSuccess:{excerpt:'Manager handles maintenance.'}}}]}});
 await withTransaction(database.session,()=>deleteCandidate(context(),{id,expectedRevision:3}));
 await withTransaction(database.session,()=>runSourceCheck(context(),payload,fetcher));expect((await listCandidates(context(),{status:'needs_review',offset:0}))).toMatchObject({value:{candidates:[]}});
});
it('honors research disable, shared count and dismissed candidates before enqueue',async()=>{
 const saved=await save();if(!saved.ok)throw new Error('save');const id=saved.value.id;
 await database.session.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,false,1)',[seeded.alpha.workspaceId]);
 expect(await requestSourceCheck(context(),{id,expectedRevision:1})).toMatchObject({ok:false,reason:'research_disabled'});
 await database.session.query('UPDATE research_settings SET enabled=true');
 await withTransaction(database.session,()=>requestSourceCheck(context(),{id,expectedRevision:1}));
 await database.session.query("UPDATE jobs SET state='dead',dead_at=now() WHERE kind='sourcing.check'");
 expect(await listCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{sourceCheck:{state:'unavailable',reason:'job_failed'}}]}});
 expect(await withTransaction(database.session,()=>requestSourceCheck(context(),{id,expectedRevision:2}))).toMatchObject({ok:false,reason:'daily_firm_ceiling'});
 await withTransaction(database.session,()=>reviewCandidate(context(),{id,expectedRevision:2,status:'dismissed'}));
 expect(await requestSourceCheck(context(),{id,expectedRevision:3})).toMatchObject({ok:false,reason:'candidate_dismissed'});
});
it('does not fetch a queued candidate after research is disabled',async()=>{
 const saved=await save();if(!saved.ok)throw new Error('save');const id=saved.value.id;
 await withTransaction(database.session,()=>requestSourceCheck(context(),{id,expectedRevision:1}));
 const job=(await database.session.query<{payload:{candidateId:string;checkId:string}}>("SELECT payload FROM jobs WHERE kind='sourcing.check'")).rows[0]!.payload;
 await database.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,false)',[seeded.alpha.workspaceId]);
 let calls=0;
 await withTransaction(database.session,()=>runSourceCheck(context(),job,{providerKey:'fixture',fetchPages:async()=>{calls++;throw new Error('no');}}));
 expect(calls).toBe(0);expect(await listCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{sourceCheck:{state:'unavailable',reason:'research_disabled'}}]}});
});
it('ignores a source result when an explicit replacement check was queued in flight',async()=>{
 const saved=await save();if(!saved.ok)throw new Error('save');const id=saved.value.id;
 await withTransaction(database.session,()=>requestSourceCheck(context(),{id,expectedRevision:1}));
 const job=(await database.session.query<{payload:{candidateId:string;checkId:string}}>("SELECT payload FROM jobs WHERE kind='sourcing.check'")).rows[0]!.payload;
 await withTransaction(database.session,()=>runSourceCheck(context(),job,{providerKey:'fixture',fetchPages:async()=>{
  await database.session.query("UPDATE jobs SET state='dead',dead_at=now() WHERE kind='sourcing.check'");
  expect(await requestSourceCheck(context(),{id,expectedRevision:2})).toMatchObject({ok:true});
  return {ok:false,costCents:0,failureCode:'old_failure'};
 }}));
 expect(await listCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{revision:3,sourceCheck:{state:'pending',reason:null}}]}});
});
it('records unavailable when the fetched snapshot cannot fit the persisted contract',async()=>{
 const saved=await save();if(!saved.ok)throw new Error('save');
 await withTransaction(database.session,()=>requestSourceCheck(context(),{id:saved.value.id,expectedRevision:1}));
 const job=(await database.session.query<{payload:{candidateId:string;checkId:string}}>("SELECT payload FROM jobs WHERE kind='sourcing.check'")).rows[0]!.payload;
 await withTransaction(database.session,()=>runSourceCheck(context(),job,{providerKey:'fixture',fetchPages:async()=>({ok:true,costCents:0,value:{pages:[{url:'https://example.test/'+ 'a'.repeat(600),contentHash:'a'.repeat(64),retrievedAt:'2026-10-05T00:00:00Z',contentType:'text/plain',body:new TextEncoder().encode('Published text'),firstParty:true}],skipped:{}}})}));
 expect(await listCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{sourceCheck:{state:'unavailable',reason:'source_unavailable',lastSuccess:null}}]}});
});
