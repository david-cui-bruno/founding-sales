import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {seedCrm,type SeededCrm} from './support/crmFixtures.ts';
let db:TestDatabase,members:TwoWorkspaces,crm:SeededCrm,runId:string;
beforeAll(async()=>{db=await createTestDatabase({throughVersion:121});members=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,members);runId=(await db.session.query<{id:string}>(`INSERT INTO research_runs(workspace_id,firm_id,revision,trigger,brief) VALUES($1,$2,1,'sweep','{"generated":false}') RETURNING id`,[members.alpha.workspaceId,crm.alpha.firmId])).rows[0]!.id;});
afterAll(async()=>{await db.drop();});
describe('0122 forward compatibility and immutable purpose',()=>{
 it('adds body-free source-owned tables and preserves every legacy brief as brief without new jobs',async()=>{
  const before=(await db.session.query('SELECT brief FROM research_runs WHERE id=$1',[runId])).rows;
  expect((await applyMigrations(db.session)).map(m=>m.version)).toContain(122);expect(await readAppliedSchemaVersion(db.session)).toBe(122);
  expect((await db.session.query('SELECT brief FROM research_runs WHERE id=$1',[runId])).rows).toEqual(before);
  expect((await db.session.query('SELECT purpose,office_assessment_capture_status FROM research_runs WHERE id=$1',[runId])).rows).toEqual([{purpose:'brief',office_assessment_capture_status:null}]);
  expect((await db.session.query("SELECT count(*)::int n FROM jobs WHERE kind='research.firm'")).rows).toEqual([{n:0}]);
  expect((await db.session.query("SELECT column_name FROM information_schema.columns WHERE table_name='firm_office_assessments' AND data_type='jsonb'")).rows).toEqual([]);
 });
 it('forbids purpose changes even before capture and on completed rows',async()=>{
  await expect(db.session.query("UPDATE research_runs SET purpose='office_evidence',trigger='user_request',requested_by_user_id=$2 WHERE id=$1",[runId,members.alpha.admin.userId])).rejects.toMatchObject({constraint:'research_run_purpose_immutable'});
  const strict=(await db.session.query<{id:string}>(`INSERT INTO research_runs(workspace_id,firm_id,revision,trigger,requested_by_user_id,purpose) VALUES($1,$2,2,'user_request',$3,'office_evidence') RETURNING id`,[members.alpha.workspaceId,crm.alpha.firmId,members.alpha.admin.userId])).rows[0]!.id;
  await db.session.query("UPDATE research_runs SET outcome='completed',completed_at=now() WHERE id=$1",[strict]);
  await expect(db.session.query("UPDATE research_runs SET purpose='brief' WHERE id=$1",[strict])).rejects.toMatchObject({constraint:'research_run_purpose_immutable'});
 });
 it('uses composite workspace/firm evidence ownership and cascades copied bodies on source deletion',async()=>{
  const keys=(await db.session.query<{conname:string;definition:string}>(`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname IN ('office_source_evidence_fkey','office_source_parent_fkey','office_assessment_run_fkey') ORDER BY conname`)).rows;
  expect(keys).toHaveLength(3);for(const key of keys){expect(key.definition).toContain('workspace_id');expect(key.definition).toContain('firm_id');expect(key.definition).toContain('ON DELETE CASCADE');}
 });
});
