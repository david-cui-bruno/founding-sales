import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
let db:TestDatabase,seed:TwoWorkspaces,before:unknown[];
const insert=(extra:Record<string,unknown>={})=>{
 const row={workspace_id:seed.alpha.workspaceId,provider_key:'aws_bedrock.campaign_opening',subject_kind:'campaign_opening',subject_id:crypto.randomUUID(),attempt:1,business_date:'2026-10-29',business_time_zone:'America/New_York',cents:1,model_name:'claude-haiku-4-5',max_input_tokens:100,max_output_tokens:256,...extra};
 return db.session.query(`INSERT INTO provider_reservations(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
};
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:145});seed=await seedTwoWorkspaces(db.session);
 await insert({provider_key:'aws_bedrock.outreach_reply',subject_kind:'outreach_reply',state:'calling'});
 await insert({provider_key:'aws_bedrock.research',subject_kind:'research_run',state:'estimated',settled_cents:1,settled_at:new Date().toISOString()});
 before=(await db.session.query('SELECT * FROM provider_reservations ORDER BY id')).rows;
 await expect(insert()).rejects.toMatchObject({constraint:'provider_reservations_subject_known'});
 await applyMigrations(db.session,{throughVersion:146});
});
afterAll(async()=>db?.drop());
it('upgrades populated145 without changing existing cost history or sender settings',async()=>{
 expect(await readAppliedSchemaVersion(db.session)).toBe(146);
 expect((await db.session.query('SELECT * FROM provider_reservations ORDER BY id')).rows).toEqual(before);
 expect((await db.session.query("SELECT 1 FROM workspace_settings WHERE setting_key='sending_enabled' AND value->>'enabled'='true'")).rows).toEqual([]);
});
it('accepts the exact new fixed-model token shape and preserves once-only reservation identity',async()=>{
 const subject=crypto.randomUUID();await insert({subject_id:subject});
 await expect(insert({subject_id:subject})).rejects.toMatchObject({constraint:'provider_reservations_one_per_attempt'});
});
it.each([{provider_key:'anthropic.campaign_opening'},{model_name:null},{max_output_tokens:1024},{max_input_tokens:10001},{priced_unit:'minute'}])('rejects new-lane funding/model/token shape drift %j',async extra=>{
 await expect(insert(extra)).rejects.toMatchObject({code:'23514'});
});
