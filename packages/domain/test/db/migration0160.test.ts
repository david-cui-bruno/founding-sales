import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
// 0160: the people spend custody (no person data, no candidate FK), the provider person copy (candidate-cascaded, application-deletable), the 'people_enrichment' setting key and a second prepared lineage trigger that proves the provider person. Additive: no routine is replaced.
let db:TestDatabase,seeded:TwoWorkspaces;
beforeAll(async()=>{db=await createTestDatabase({throughVersion:159});seeded=await seedTwoWorkspaces(db.session);});
afterAll(async()=>{await db.drop();});
it('has no people tables at 159 and creates them at 160 without touching stored settings',async()=>{
 expect((await db.session.query("SELECT to_regclass('outreach_people_contacts') AS a,to_regclass('outreach_people_lookups') AS b")).rows).toEqual([{a:null,b:null}]);
 const before=(await db.session.query('SELECT to_jsonb(s) AS s FROM workspace_settings s ORDER BY id')).rows;
 await applyMigrations(db.session,{throughVersion:160});
 expect(await readAppliedSchemaVersion(db.session)).toBe(160);
 expect((await db.session.query('SELECT to_jsonb(s) AS s FROM workspace_settings s ORDER BY id')).rows).toEqual(before);
});
it('admits the people_enrichment setting key and keeps every earlier key',async()=>{
 const definition=(await db.session.query<{def:string}>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='workspace_settings_key_known'")).rows[0]?.def??'';
 for(const key of ['business_time_zone','sending_enabled','booking_policy','meeting_auto_recording','booking_link','people_enrichment'])expect(definition).toContain(key);
});
const grants=async(table:string)=>(await db.session.query<{privilege_type:string}>("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee='app_runtime' ORDER BY privilege_type",[table])).rows.map(row=>row.privilege_type);
it('lets the application add, read and update spend custody but never delete it, and add, read and delete (never update) a person copy',async()=>{
 expect(await grants('outreach_people_lookups')).toEqual(['INSERT','SELECT','UPDATE']);
 expect(await grants('outreach_people_contacts')).toEqual(['DELETE','INSERT','SELECT']);
 expect(seeded.alpha.workspaceId).toBeDefined();
});
it('keeps spend custody independent of the candidate and free of personal data, and cascades only the person copy with the candidate',async()=>{
 const columns=(await db.session.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_name='outreach_people_lookups'")).rows.map(row=>row.column_name);
 for(const personal of ['first_name','last_name','title','email','provider_person_id','email_status','match_confidence'])expect(columns).not.toContain(personal);
 const foreign=async(table:string)=>(await db.session.query<{conname:string;confrelid:string;confdeltype:string}>("SELECT conname,confrelid::regclass::text AS confrelid,confdeltype FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f' ORDER BY conname",[table])).rows;
 expect(await foreign('outreach_people_lookups')).toEqual([]);
 expect(await foreign('outreach_people_contacts')).toEqual([{conname:'outreach_people_contacts_candidate_fkey',confrelid:'sourcing_candidates',confdeltype:'c'},{conname:'outreach_people_contacts_lookup_fkey',confrelid:'outreach_people_lookups',confdeltype:'a'}]);
});
it('adds the person lineage trigger beside 0158\'s, leaving that function as it was',async()=>{
 for(const name of ['email_campaign_prepared_lineage','email_campaign_prepared_person_lineage'])expect((await db.session.query('SELECT 1 FROM pg_trigger WHERE tgname=$1 AND NOT tgisinternal',[name])).rows,name).toHaveLength(1);
 expect((await db.session.query<{src:string}>("SELECT prosrc AS src FROM pg_proc WHERE proname='outreach_email_campaign_prepared_lineage'")).rows[0]?.src??'').not.toContain('outreach_people_contacts');
 const body=(await db.session.query<{src:string}>("SELECT prosrc AS src FROM pg_proc WHERE proname='outreach_email_campaign_prepared_person_lineage'")).rows[0]?.src??'';
 expect(body).toContain('outreach_people_lookups');expect(body).toContain('outreach_people_contacts');expect(body).toContain("p.state='found'");
});
