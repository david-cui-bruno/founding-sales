import {afterAll,beforeAll,beforeEach,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate,reviewCandidate,listCandidates} from '../../sourcing/candidates.ts';
import {requestSourceCheck,runSourceCheck} from '../../sourcing/sourceCheck.ts';
import {monitorCandidateSources} from '../../sourcing/monitoring.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=(which:'alpha'|'beta'='alpha')=>repositoryContext(workspaceScope(seed[which].workspaceId,{kind:'system',component:'worker'}),db.session);
const draft={firmName:'Example PM',website:'https://example.test',locality:'Dallas',region:'TX' as const,signal:'fit_only' as const,evidence:'Maintenance support',sourceUrl:'https://example.test/maintenance',observedOn:'2026-10-01',preparedBy:'test'};
async function candidate(name:string,status:'kept'|'needs_review'|'dismissed'='kept',which:'alpha'|'beta'='alpha'){
 const saved=await saveCandidate(ctx(which),{...draft,firmName:name});if(!saved.ok)throw new Error('save');
 if(status!=='needs_review')await reviewCandidate(ctx(which),{id:saved.value.id,expectedRevision:1,status});return saved.value.id;
}
const sweep=()=>withTransaction(db.session,()=>monitorCandidateSources(ctx()));
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query("DELETE FROM jobs WHERE kind='sourcing.check'");await db.session.query('DELETE FROM daily_counters');await db.session.query('DELETE FROM research_settings');});
afterAll(async()=>{await db.drop();});
it('monitors only kept due candidates in this workspace and does not repeat on the next sweep',async()=>{
 await candidate('due');await candidate('unreviewed','needs_review');await candidate('dismissed','dismissed');await candidate('other workspace','kept','beta');
 const fresh=await candidate('fresh');await db.session.query("UPDATE sourcing_candidates SET next_source_check_at=now()+interval '1 day' WHERE id=$1",[fresh]);
 expect(await sweep()).toMatchObject({queued:1});expect(await sweep()).toMatchObject({queued:0});
 const jobs=await db.session.query('SELECT workspace_id,payload FROM jobs');expect(jobs.rows).toHaveLength(1);expect(jobs.rows[0]).toMatchObject({workspace_id:seed.alpha.workspaceId});expect(JSON.stringify(jobs.rows)).not.toContain('example.test');
 expect(await listCandidates(ctx(),{status:'kept',offset:0})).toMatchObject({ok:true});
});
it('leaves excess candidates due when shared daily count is exhausted and resumes later',async()=>{
 await db.session.query('INSERT INTO research_settings(workspace_id,daily_firm_ceiling) VALUES($1,1)',[seed.alpha.workspaceId]);
 await candidate('first');await candidate('second');expect(await sweep()).toMatchObject({queued:1});expect(await sweep()).toMatchObject({queued:0});
 expect((await db.session.query("SELECT id FROM sourcing_candidates WHERE next_source_check_at<=now()")).rows).toHaveLength(1);
 await db.session.query('DELETE FROM daily_counters');expect(await sweep()).toMatchObject({queued:1});
});
it('research disable leaves the due date untouched, and leaving kept removes it',async()=>{
 const id=await candidate('due');await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,false)',[seed.alpha.workspaceId]);
 expect(await sweep()).toMatchObject({queued:0});expect((await db.session.query("SELECT id FROM sourcing_candidates WHERE next_source_check_at<=now()")).rows).toHaveLength(1);
 await reviewCandidate(ctx(),{id,expectedRevision:2,status:'needs_review'});
 expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{nextSourceCheckAt:null}]}});
});
it('manual checks reset weekly cadence; terminal jobs can be retried once due',async()=>{
 const id=await candidate('due');await withTransaction(db.session,()=>requestSourceCheck(ctx(),{id,expectedRevision:2}));expect(await sweep()).toMatchObject({queued:0});
 await db.session.query("UPDATE jobs SET state='dead',dead_at=now() WHERE kind='sourcing.check'");
 await db.session.query("UPDATE sourcing_candidates SET next_source_check_at=now()-interval '1 day'");expect(await sweep()).toMatchObject({queued:1});expect(await sweep()).toMatchObject({queued:0});
});
it('bounds one sweep to 25 and retains the remaining due candidates',async()=>{
 for(let i=0;i<27;i++)await candidate(`firm ${i}`);
 expect(await sweep()).toMatchObject({queued:25});expect((await db.session.query('SELECT id FROM sourcing_candidates WHERE next_source_check_at<=now()')).rows).toHaveLength(2);
});

it('stops an already queued scheduled check when the candidate returns to review',async()=>{
 const id=await candidate('queued');await sweep();
 const job=(await db.session.query<{payload:{candidateId:string;checkId:string;scheduled:boolean}}>("SELECT payload FROM jobs WHERE kind='sourcing.check'")).rows[0]!.payload;
 expect(job.scheduled).toBe(true);
 await reviewCandidate(ctx(),{id,expectedRevision:3,status:'needs_review'});
 let calls=0;
 await withTransaction(db.session,()=>runSourceCheck(ctx(),job,{providerKey:'test',fetchPages:async()=>{calls++;throw new Error('should not fetch');}}));
 expect(calls).toBe(0);expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{sourceCheck:{state:'unavailable',reason:'candidate_not_monitored'}}]}});
});
