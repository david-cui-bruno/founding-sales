import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
// 0160: the people-contact ledger, the 'people_enrichment' setting key and a second prepared lineage trigger that proves the provider person. Additive: no routine is replaced.
let db:TestDatabase,seeded:TwoWorkspaces;
beforeAll(async()=>{db=await createTestDatabase({throughVersion:159});seeded=await seedTwoWorkspaces(db.session);});
afterAll(async()=>{await db.drop();});
it('has no people-contact table at 159 and creates it at 160 without touching stored settings',async()=>{
 expect((await db.session.query("SELECT to_regclass('outreach_people_contacts') AS t")).rows).toEqual([{t:null}]);
 const before=(await db.session.query('SELECT to_jsonb(s) AS s FROM workspace_settings s ORDER BY id')).rows;
 await applyMigrations(db.session,{throughVersion:160});
 expect(await readAppliedSchemaVersion(db.session)).toBe(160);
 expect((await db.session.query('SELECT to_jsonb(s) AS s FROM workspace_settings s ORDER BY id')).rows).toEqual(before);
});
it('admits the people_enrichment setting key and keeps every earlier key',async()=>{
 const definition=(await db.session.query<{def:string}>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='workspace_settings_key_known'")).rows[0]?.def??'';
 for(const key of ['business_time_zone','sending_enabled','booking_policy','meeting_auto_recording','booking_link','people_enrichment'])expect(definition).toContain(key);
});
it('lets the application add, read and update contacts but never delete one',async()=>{
 const rows=(await db.session.query<{privilege_type:string}>("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='outreach_people_contacts' AND grantee='app_runtime' ORDER BY privilege_type")).rows.map(row=>row.privilege_type);
 expect(rows).toEqual(['INSERT','SELECT','UPDATE']);
 expect(seeded.alpha.workspaceId).toBeDefined();
});
it('adds the person lineage trigger beside 0158\'s, leaving that function as it was',async()=>{
 for(const name of ['email_campaign_prepared_lineage','email_campaign_prepared_person_lineage'])expect((await db.session.query('SELECT 1 FROM pg_trigger WHERE tgname=$1 AND NOT tgisinternal',[name])).rows,name).toHaveLength(1);
 expect((await db.session.query<{src:string}>("SELECT prosrc AS src FROM pg_proc WHERE proname='outreach_email_campaign_prepared_lineage'")).rows[0]?.src??'').not.toContain('outreach_people_contacts');
 const body=(await db.session.query<{src:string}>("SELECT prosrc AS src FROM pg_proc WHERE proname='outreach_email_campaign_prepared_person_lineage'")).rows[0]?.src??'';
 expect(body).toContain('outreach_people_contacts');expect(body).toContain("p.state='found'");
});
