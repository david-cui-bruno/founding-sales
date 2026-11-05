import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';

it('refuses overdue old-provider marked attempts before cutover and conserves historical/source/calibration/credential custody after explicit resolution',async()=>{
 const db=await createTestDatabase({throughVersion:166});try{
  const seed=await seedTwoWorkspaces(db.session),w=seed.alpha.workspaceId,u=seed.alpha.admin.userId,account=randomUUID(),credential=randomUUID(),plan=randomUUID(),slot=randomUUID(),input=randomUUID();
  await db.session.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,adapter_version,verified_at,max_schedule_days) VALUES($1,$2,$3,'linkedin','https://www.linkedin.com/in/rollback-fixture','Rollback fixture','profile','connected','linkedin-web-chromium-v1',clock_timestamp(),30)",[w,account,u]);
  await db.session.query("INSERT INTO social_publisher_sessions(workspace_id,id,owner_user_id,account_id,account_revision,external_id,encrypted_state,state,verified_at,expires_at) VALUES($1,$2,$3,$4,1,'https://www.linkedin.com/in/rollback-fixture',$5,'usable',clock_timestamp(),clock_timestamp()+interval '7 days')",[w,credential,u,account,Buffer.alloc(29,17)]);
  await db.session.query("INSERT INTO social_founder_inputs(workspace_id,owner_user_id,id,bullets,context,public_safe) VALUES($1,$2,$3,'Genuine input remains current.','Owned source fixture',true)",[w,u,input]);
  await db.session.query('INSERT INTO social_voice_preferences(workspace_id,owner_user_id,revision,entries) VALUES($1,$2,4,$3::jsonb)',[w,u,JSON.stringify([{entryId:randomUUID(),dimension:'tone',guidance:'Use plain first-person wording.'}])]);
  await db.session.query('INSERT INTO social_founder_calibrations(workspace_id,owner_user_id,id,examples) VALUES($1,$2,$3,$4::jsonb)',[w,u,randomUUID(),JSON.stringify([1,2,3].map(()=>({draftId:randomUUID(),revision:1})))]);
  const binding={workspaceId:w,ownerUserId:u,accountId:account,accountRevision:1,sessionId:credential,sessionRevision:1,externalId:'https://www.linkedin.com/in/rollback-fixture'};
  await db.session.query("INSERT INTO social_standing_plans(workspace_id,id,owner_user_id,state,configuration,budget_timezone) VALUES($1,$2,$3,'active',$4::jsonb,'UTC')",[w,plan,u,JSON.stringify({binding})]);
  await db.session.query("INSERT INTO social_standing_slots(workspace_id,id,owner_user_id,plan_id,plan_revision,local_week,ordinal,publish_at,state,input_refs,attempt_id,fingerprint,submission_marked_at,post_id,snapshot,inspection_deadline) VALUES($1,$2,$3,$4,1,'2026-10-19',1,clock_timestamp()-interval '3 days','unknown',$5::jsonb,$6,$7,clock_timestamp()-interval '4 days',$8,$9::jsonb,clock_timestamp()-interval '2 days')",[w,slot,u,plan,JSON.stringify([{inputId:input,revision:1}]),randomUUID(),'a'.repeat(64),randomUUID(),JSON.stringify({binding,text:null,textSHA256:'b'.repeat(64),publishAt:'2026-10-20T12:00:00Z',image:null})]);
  await db.session.query('INSERT INTO social_standing_lineage(workspace_id,owner_user_id,input_id,slot_id) VALUES($1,$2,$3,$4)',[w,u,input,slot]);
  const tables=['social_publisher_sessions','social_founder_inputs','social_voice_preferences','social_founder_calibrations','social_standing_lineage'];
  const before=new Map<string,unknown>();for(const table of tables)before.set(table,(await db.session.query(`SELECT * FROM ${table}`)).rows);
  const attempts=(await db.session.query('SELECT * FROM social_standing_slots')).rows;
  await expect(applyMigrations(db.session,{throughVersion:167})).rejects.toThrow('social_old_publisher_unresolved_attempts');
  expect(await readAppliedSchemaVersion(db.session)).toBe(166);expect((await db.session.query('SELECT * FROM social_standing_slots')).rows).toEqual(attempts);
  // Explicit provider-resolution fixture, never a deadline-based abandonment.
  await db.session.query("UPDATE social_standing_slots SET state='cancelled' WHERE workspace_id=$1 AND id=$2",[w,slot]);
  const resolved=(await db.session.query('SELECT * FROM social_standing_slots')).rows;
  await applyMigrations(db.session,{throughVersion:167});expect(await readAppliedSchemaVersion(db.session)).toBe(167);
  for(const table of tables)expect((await db.session.query(`SELECT * FROM ${table}`)).rows).toEqual(before.get(table));
  const after=(await db.session.query('SELECT * FROM social_standing_slots')).rows;expect(after).toEqual(resolved.map(row=>({...row,media_receipt_id:null,observed_at:null})));
  expect((await db.session.query('SELECT state,revision,configuration FROM social_standing_plans')).rows).toEqual([{state:'paused',revision:2,configuration:{binding}}]);
  expect((await db.session.query('SELECT * FROM social_publisher_credentials')).rows).toEqual([]);
  expect((await db.session.query('SELECT * FROM social_buffer_publisher_runtime')).rows).toEqual([]);
 }finally{await db.drop();}
});
