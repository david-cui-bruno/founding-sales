import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {seedCrm,type SeededCrm} from './support/crmFixtures.ts';
import {RETAINED_RECOVERY_CONSTRAINT_CASES} from './support/retainedRecoveryCases.ts';
let db:TestDatabase,seeded:TwoWorkspaces,crm:SeededCrm;
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:132});seeded=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,seeded);
 expect(await readAppliedSchemaVersion(db.session)).toBe(132);
 await applyMigrations(db.session);expect(await readAppliedSchemaVersion(db.session)).toBe(133);
});
afterAll(async()=>{await db.drop();});
it.each(RETAINED_RECOVERY_CONSTRAINT_CASES)('132 to 133 upgrade enforces $constraint with a real failing insert',async testCase=>{
 await db.session.query('BEGIN');
 try{await expect(testCase.run({session:db.session,seeded,crm})).rejects.toMatchObject({constraint:testCase.constraint});}
 finally{await db.session.query('ROLLBACK');}
});
it('does not grant mutable runtime lineage or fence authority on upgrade',async()=>{
 for(const table of ['sourcing_retained_identity_decisions','sourcing_retained_firm_acquisition_fences']){
  expect((await db.session.query("SELECT has_table_privilege('app_runtime',$1,'SELECT') AS read,has_table_privilege('app_runtime',$1,'INSERT') AS insert,has_table_privilege('app_runtime',$1,'UPDATE') AS update",[table])).rows).toEqual([{read:true,insert:true,update:false}]);
 }
});
