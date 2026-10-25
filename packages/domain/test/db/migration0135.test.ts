import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {SOCIAL_PRIVATE_CONSTRAINT_CASES,privateDraftRow,insertPrivateDraft} from './support/socialPrivateCases.ts';
let db:TestDatabase,seeded:TwoWorkspaces;
beforeAll(async()=>{db=await createTestDatabase({throughVersion:134});seeded=await seedTwoWorkspaces(db.session);expect(await readAppliedSchemaVersion(db.session)).toBe(134);await applyMigrations(db.session,{throughVersion:135});expect(await readAppliedSchemaVersion(db.session)).toBe(135);});
afterAll(async()=>{await db?.drop();});
it.each(SOCIAL_PRIVATE_CONSTRAINT_CASES)('134 to 135 rejects $constraint',async testCase=>{await db.session.query('BEGIN');try{await expect(testCase.run({session:db.session,seeded})).rejects.toMatchObject({constraint:testCase.constraint});}finally{await db.session.query('ROLLBACK');}});
it('app_runtime owns only current private composition and all constraints are classified',async()=>{
 const runtime=await db.appRuntimeSession();expect((await runtime.query('SELECT current_user')).rows[0]?.['current_user']).toBe('app_runtime');
 const f={session:runtime,seeded};await insertPrivateDraft(f,privateDraftRow(f));
 const constraints=(await runtime.query("SELECT conname FROM pg_constraint WHERE conrelid='social_private_drafts'::regclass ORDER BY conname")).rows.map(r=>r['conname']);expect(constraints).toEqual(SOCIAL_PRIVATE_CONSTRAINT_CASES.map(c=>c.constraint).sort());
 expect((await runtime.query('SELECT count(*)::int n FROM social_accounts')).rows[0]?.['n']).toBe(0);
});
