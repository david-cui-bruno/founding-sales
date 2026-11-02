import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
// 0158: prepared_capture campaign admissions, the append-only free-check table and the lineage trigger. Widening only.
let db:TestDatabase,seeded:TwoWorkspaces;
const key='a'.repeat(64);
const record=(address:string,result:string,outcome:string,provider='dns_mx')=>db.session.query('INSERT INTO outreach_email_verifications(workspace_id,address_key,provider,result,outcome) VALUES($1,$2,$3,$4,$5)',[seeded.alpha.workspaceId,address,provider,result,outcome]);
beforeAll(async()=>{db=await createTestDatabase({throughVersion:157});seeded=await seedTwoWorkspaces(db.session);});
afterAll(async()=>{await db.drop();});
it('upgrades 157 to 158 and keeps the three existing source kinds',async()=>{
 await applyMigrations(db.session,{throughVersion:158});
 expect(await readAppliedSchemaVersion(db.session)).toBe(158);
 const definition=(await db.session.query<{def:string}>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='email_campaign_admission_source'")).rows[0]?.def??'';
 for(const kind of ['discovery_research','automatic_research','prepared_capture'])expect(definition).toContain(kind);
});
it('records only a digest key with a valid result and its matching outcome from the in-house provider',async()=>{
 await record(key,'valid','ok');await record(key,'invalid','drop');
 for(const [address,result,outcome,provider] of [['not-a-digest','valid','ok','dns_mx'],[key,'unknown','ok','dns_mx'],[key,'valid','drop','dns_mx'],[key,'invalid','ok','dns_mx'],[key,'valid','ok','neverbounce']] as const)
  await expect(record(address,result,outcome,provider),`${address}/${result}/${outcome}/${provider}`).rejects.toMatchObject({code:'23514'});
});
it('lets the application add and read checks but never rewrite or delete one',async()=>{
 const rows=(await db.session.query<{privilege_type:string}>("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='outreach_email_verifications' AND grantee='app_runtime' ORDER BY privilege_type")).rows.map(row=>row.privilege_type);
 expect(rows).toEqual(['INSERT','SELECT']);
});
it('guards prepared admissions with a lineage trigger',async()=>{
 expect((await db.session.query("SELECT 1 FROM pg_trigger WHERE tgname='email_campaign_prepared_lineage' AND NOT tgisinternal")).rows).toHaveLength(1);
});
