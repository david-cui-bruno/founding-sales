import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
import {seedPreparedProspect} from '../sourcing/preparedProspectsPgFixture.ts';
// 0159: advisory Callable-today rank rows. Additive: one new table and one run trigger; no stored row is rewritten.
let db:TestDatabase,w:string,seeded:Awaited<ReturnType<typeof seedPreparedProspect>>;
const rank=(rankValue:number|null,expires="now()+interval '1 day'")=>db.session.query(`INSERT INTO sourcing_callable_ranks(workspace_id,candidate_id,candidate_revision,run_id,rank,company_host,expires_at)
 VALUES($1,$2,1,$3,$4,'cedar.example.test',${expires})`,[w,seeded.candidateId,seeded.runId,rankValue]);
const count=async()=>(await db.session.query<{n:string}>('SELECT count(*) AS n FROM sourcing_callable_ranks')).rows[0]!.n;
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:158});w=(await seedTwoWorkspaces(db.session)).alpha.workspaceId;
 seeded=await seedPreparedProspect(repositoryContext(workspaceScope(w,{kind:'system',component:'worker'}),db.session),1);
});
afterAll(async()=>{await db.drop();});
it('has no rank table at 158 and creates it at 159 without touching candidates or runs',async()=>{
 expect((await db.session.query("SELECT to_regclass('sourcing_callable_ranks') AS t")).rows).toEqual([{t:null}]);
 const before=(await db.session.query('SELECT to_jsonb(r) AS r FROM sourcing_qualification_runs r')).rows;
 await applyMigrations(db.session,{throughVersion:159});
 expect(await readAppliedSchemaVersion(db.session)).toBe(159);
 expect((await db.session.query('SELECT to_jsonb(r) AS r FROM sourcing_qualification_runs r')).rows).toEqual(before);
});
it('bounds rank, host and expiry and keeps one row per candidate',async()=>{
 await expect(rank(16)).rejects.toMatchObject({code:'23514'});await expect(rank(-1)).rejects.toMatchObject({code:'23514'});
 await expect(rank(1,"now()+interval '9 days'")).rejects.toMatchObject({code:'23514'});await expect(rank(1,"now()-interval '1 day'")).rejects.toMatchObject({code:'23514'});
 await rank(null);await expect(rank(3)).rejects.toMatchObject({code:'23505'});expect(await count()).toBe('1');
});
it('deletes the row when its run evidence changes and cascades from the candidate',async()=>{
 await db.session.query("UPDATE sourcing_qualification_runs SET reason='no_readable_text' WHERE id=$1",[seeded.runId]);expect(await count()).toBe('0');
 await rank(5);await db.session.query("UPDATE sourcing_qualification_runs SET admission_checked_at=now() WHERE id=$1",[seeded.runId]);expect(await count()).toBe('1');
 await db.session.query('DELETE FROM sourcing_candidates WHERE id=$1',[seeded.candidateId]);expect(await count()).toBe('0');
});
