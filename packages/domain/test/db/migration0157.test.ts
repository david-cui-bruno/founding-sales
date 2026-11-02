import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {SENDING_STOP_LINE,US_BUSINESS_REGIONS} from '@fss/contracts';
import {sendFooterBlock} from '../../src/rules/templates.ts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {seedCrm} from './support/crmFixtures.ts';
import {seedMail} from './support/mailFixtures.ts';
// 0157: campaign regions widen from TX/RI/MA to the 50 states and DC, and workspace_settings admits 'booking_link'.
// Touches-existing, widening only: two CHECKs re-added with strictly larger sets; no row is rewritten.
let db:TestDatabase,seeded:TwoWorkspaces,mailboxId:string,sequenceVersionId:string,campaignId:string;
const w=()=>seeded.alpha.workspaceId;
const campaign=(regions:(string|null)[],id:string=randomUUID())=>db.session.query(
 `INSERT INTO outreach_email_campaigns(workspace_id,id,owner_user_id,mailbox_id,sequence_version_id,authorization_revision,regions,max_enrollments,daily_admission_limit,approved_at,expires_at)
  VALUES($1,$2,$3,$4,$5,1,$6::text[],25,5,'2026-11-01T12:00:00Z','2026-11-02T12:00:00Z')`,[w(),id,seeded.alpha.admin.userId,mailboxId,sequenceVersionId,regions]);
const setting=(key:string,value:unknown,version=1)=>db.session.query(
 'INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id) VALUES($1,$2,$3,$4::jsonb,$5)',[w(),key,version,JSON.stringify(value),seeded.alpha.admin.userId]);
const stored=async()=>({campaigns:(await db.session.query('SELECT * FROM outreach_email_campaigns ORDER BY id')).rows,settings:(await db.session.query('SELECT * FROM workspace_settings ORDER BY setting_key,version')).rows});
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:156});seeded=await seedTwoWorkspaces(db.session);
 mailboxId=(await seedMail(db.session,seeded,await seedCrm(db.session,seeded))).alpha.mailboxId;
 const sequence=randomUUID();sequenceVersionId=randomUUID();campaignId=randomUUID();
 await db.session.query("INSERT INTO sequences(workspace_id,id,name,created_by_user_id) VALUES($1,$2,'Upgrade campaign catalog',$3)",[w(),sequence,seeded.alpha.admin.userId]);
 await db.session.query('INSERT INTO sequence_versions(workspace_id,id,sequence_id,version) VALUES($1,$2,$3,1)',[w(),sequenceVersionId,sequence]);
 await campaign(['TX','RI','MA'],campaignId);await setting('postal_address',{address:'1 Example Way'});
});
afterAll(async()=>{await db.drop();});
it('refuses WA and booking_link at 156, then upgrades to 157 leaving every stored row untouched',async()=>{
 await expect(campaign(['WA'])).rejects.toMatchObject({code:'23514',constraint:'email_campaign_regions'});
 await expect(setting('booking_link',{url:'https://cal.example.test/demo'})).rejects.toMatchObject({code:'23514',constraint:'workspace_settings_key_known'});
 const before=await stored();
 await applyMigrations(db.session,{throughVersion:157});
 expect(await readAppliedSchemaVersion(db.session)).toBe(157);expect(await stored()).toEqual(before);
});
it('accepts WA, DC and all 51 regions, and keeps refusing invalid, duplicate, null and empty region sets',async()=>{
 await db.session.query('UPDATE outreach_email_campaigns SET revision=2,revoked_at=approved_at+interval \'1 hour\' WHERE id=$1',[campaignId]);
 await campaign(['WA']);
 await db.session.query("UPDATE outreach_email_campaigns SET revision=2,revoked_at='2026-11-01T13:00:00Z' WHERE workspace_id=$1 AND regions=ARRAY['WA']::text[]",[w()]);
 await campaign(['TX','DC']);
 await db.session.query("UPDATE outreach_email_campaigns SET revision=2,revoked_at='2026-11-01T13:00:00Z' WHERE workspace_id=$1 AND regions=ARRAY['TX','DC']::text[]",[w()]);
 await campaign([...US_BUSINESS_REGIONS]);
 await db.session.query("UPDATE outreach_email_campaigns SET revision=2,revoked_at='2026-11-01T13:00:00Z' WHERE workspace_id=$1 AND cardinality(regions)=51",[w()]);
 const refused:(string|null)[][]=[[],['PR'],['tx'],['TX','TX'],['WA','TX','WA'],['TX',null],[...US_BUSINESS_REGIONS,'TX'],[...US_BUSINESS_REGIONS,'PR']];
 for(const regions of refused)await expect(campaign(regions),JSON.stringify(regions)).rejects.toMatchObject({code:'23514',constraint:'email_campaign_regions'});
 await expect(db.session.query('UPDATE outreach_email_campaigns SET regions=ARRAY[\'WA\']::text[] WHERE id=$1',[campaignId])).rejects.toMatchObject({code:'23514',constraint:'email_campaign_immutable'});
});
it('names exactly US_BUSINESS_REGIONS in the SQL list',()=>{
 const sql=readFileSync(new URL('../../db/migrations/0157_email_campaign_nationwide_and_booking_link.sql',import.meta.url),'utf8');
 const list=/r <@ ARRAY\[([^\]]*)\]/u.exec(sql)?.[1];
 expect([...(list??'').matchAll(/'([A-Z]{2})'/gu)].map(match=>match[1])).toEqual([...US_BUSINESS_REGIONS]);
});
it('admits the booking_link setting row and still refuses an unknown key',async()=>{
 await setting('booking_link',{url:'https://cal.example.test/demo'});
 expect((await db.session.query("SELECT value FROM workspace_settings WHERE setting_key='booking_link'")).rows).toEqual([{value:{url:'https://cal.example.test/demo'}}]);
 await expect(setting('something_an_admin_invented',{})).rejects.toMatchObject({code:'23514',constraint:'workspace_settings_key_known'});
 for(const key of ['business_time_zone','sending_enabled','booking_policy','meeting_auto_recording'])
  await expect(setting(key,{}, 7)).resolves.toBeDefined();
});
it('replaces the opening-fence footer rebuild with the constants the TS composer writes',async()=>{
 const block=sendFooterBlock({signOff:'Sam',postalAddress:'1 Example Way'});
 const body=(await db.session.query<{def:string}>("SELECT pg_get_functiondef('campaign_opening_footer_body(uuid,uuid,text)'::regprocedure) def")).rows[0]!.def;
 const company=/company constant text := '([^']*)'/u.exec(body)?.[1];
 const stop=/stop constant text := '((?:[^']|'')*)'/u.exec(body)?.[1]?.replaceAll("''","'");
 expect(block).toBe(`Sam\n${company} · 1 Example Way\n${stop}`);
 expect(stop).toBe(SENDING_STOP_LINE);
});
