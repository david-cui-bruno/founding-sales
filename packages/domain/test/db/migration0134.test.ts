import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {MANUAL_PROSPECT_CONSTRAINT_CASES} from './support/manualProspectCases.ts';
let db:TestDatabase,seeded:TwoWorkspaces;
beforeAll(async()=>{db=await createTestDatabase({throughVersion:133});seeded=await seedTwoWorkspaces(db.session);expect(await readAppliedSchemaVersion(db.session)).toBe(133);await applyMigrations(db.session, {throughVersion:134});expect(await readAppliedSchemaVersion(db.session)).toBe(134);});
afterAll(async()=>{await db.drop();});
it.each(MANUAL_PROSPECT_CONSTRAINT_CASES)('133 to 134 rejects $constraint',async testCase=>{
 await db.session.query('BEGIN');try{await expect(testCase.run({session:db.session,seeded})).rejects.toMatchObject({constraint:testCase.constraint});}finally{await db.session.query('ROLLBACK');}
});
it('grants only the new reversible store to runtime and leaves canonical grants unchanged',async()=>{
 const runtime=await db.appRuntimeSession();
 expect((await runtime.query("SELECT current_user,has_table_privilege(current_user,'sourcing_manual_prospect_states','SELECT,INSERT,UPDATE,DELETE') AS allowed")).rows).toEqual([{current_user:'app_runtime',allowed:true}]);
 const constraints=(await runtime.query("SELECT conname FROM pg_constraint WHERE conrelid='sourcing_manual_prospect_states'::regclass ORDER BY conname")).rows.map(row=>row['conname']);
 expect(constraints).toEqual(MANUAL_PROSPECT_CONSTRAINT_CASES.map(row=>row.constraint).sort());
});
