import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate,reviewCandidate} from '@fss/domain/sourcing/candidates.ts';
import {enqueueJob} from '@fss/domain/jobs/jobStore.ts';
import {sourcingQualificationSource} from '../src/handlers/sourcingQualification.ts';
let db:TestDatabase;let workspaceId:string;
beforeAll(async()=>{db=await createTestDatabase();workspaceId=(await seedTwoWorkspaces(db.session)).alpha.workspaceId;});afterAll(async()=>db.drop());
it('drains more than one page of new candidates, skips dismissed drafts, and deduplicates repeated passes',async()=>{
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 for(let n=0;n<31;n++){
  const saved=await saveCandidate(ctx,{firmName:`PM ${n}`,website:`https://p${n}.example.test/`,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Need unknown',sourceUrl:`https://p${n}.example.test/`,observedOn:'2026-10-01',preparedBy:'Fixture'});
  if(!saved.ok)throw new Error(saved.reason);if(n===30)await reviewCandidate(ctx,{id:saved.value.id,expectedRevision:1,status:'dismissed'});
 }
 const source=sourcingQualificationSource(true);
 const pass=async()=>withTransaction(db.session,async()=>{const jobs=await source.find(db.session,new Date().toISOString());for(const job of jobs)await enqueueJob(db.session,job);return jobs.length;});
 expect(await pass()).toBe(25);expect(await pass()).toBe(5);expect(await pass()).toBe(0);
 expect((await db.session.query("SELECT id FROM jobs WHERE kind='sourcing.qualify'")).rows).toHaveLength(30);
 await db.session.query("UPDATE sourcing_qualification_runs SET requested_at=now()-interval '1 hour',deadline_at=now()-interval '1 minute'");
 await withTransaction(db.session,()=>sourcingQualificationSource(false).find(db.session,new Date().toISOString()));
 expect((await db.session.query("SELECT id FROM sourcing_qualification_runs WHERE state='unavailable'")).rows).toHaveLength(30);
});
it('leaves paused and quota-limited candidates pending with a visible reason, sharing the research ceiling',async()=>{
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 await db.session.query('DELETE FROM sourcing_candidates');
 await saveCandidate(ctx,{firmName:'Budget PM',website:'https://budget.example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:'https://budget.example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'});
 await db.session.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,false,0)',[workspaceId]);
 const pass=()=>withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()));
 expect(await pass()).toEqual([]);
 expect((await db.session.query('SELECT qualification_wait_reason FROM sourcing_discovery_settings WHERE workspace_id=$1',[workspaceId])).rows[0]).toEqual({qualification_wait_reason:'research_disabled'});
 await db.session.query('UPDATE research_settings SET enabled=true WHERE workspace_id=$1',[workspaceId]);
 expect(await pass()).toEqual([]);
 expect((await db.session.query('SELECT qualification_wait_reason FROM sourcing_discovery_settings WHERE workspace_id=$1',[workspaceId])).rows[0]).toEqual({qualification_wait_reason:'daily_firm_ceiling'});
 expect((await db.session.query('SELECT id FROM sourcing_qualification_runs')).rows).toHaveLength(0);
});

it('reconsiders an eligible run after activation without another research reservation',async()=>{
 await db.session.query('UPDATE research_settings SET enabled=true,daily_firm_ceiling=50 WHERE workspace_id=$1',[workspaceId]);
 await db.session.query('DELETE FROM daily_counters');
 const first=await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()));
 expect(first).toHaveLength(1);
 const runId=first[0]!.payload['runId'];
 await db.session.query("UPDATE sourcing_qualification_runs SET state='eligible' WHERE id=$1",[runId]);
 const before=(await db.session.query('SELECT * FROM daily_counters')).rows;
 expect(await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()))).toHaveLength(0);
 await db.session.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=true WHERE workspace_id=$1',[workspaceId]);
 const retry=await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()));
 expect(retry).toHaveLength(1);expect(retry[0]!.payload['runId']).toBe(runId);
 expect(retry[0]!.idempotencyKey).not.toBe(first[0]!.idempotencyKey);
 expect((await db.session.query('SELECT * FROM daily_counters')).rows).toEqual(before);
 expect(await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()))).toHaveLength(0);
});
it('gives later workspaces a turn even when more than 25 earlier workspaces are paused',async()=>{
 const wanted=new Set<string>();
 for(let n=0;n<14;n++){
  await db.session.query("UPDATE workspaces SET slug=slug||'-'||$1 WHERE slug IN ('alpha','beta')",[String(n)]);
  const pair=await seedTwoWorkspaces(db.session);
  for(const workspace of [pair.alpha,pair.beta]){
   wanted.add(workspace.workspaceId);
   const ctx=repositoryContext(workspaceScope(workspace.workspaceId,{kind:'system',component:'worker'}),db.session);
   await saveCandidate(ctx,{firmName:'Waiting PM',website:'https://waiting.example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:'https://waiting.example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'});
   await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,false)',[workspace.workspaceId]);
  }
 }
 for(let n=0;n<2;n++)await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date(Date.now()+n*1000).toISOString()));
 const visited=(await db.session.query<{workspace_id:string}>('SELECT workspace_id FROM sourcing_discovery_settings WHERE qualification_last_pass_at IS NOT NULL')).rows;
 for(const row of visited)wanted.delete(row.workspace_id);
 expect(wanted.size).toBe(0);
});
