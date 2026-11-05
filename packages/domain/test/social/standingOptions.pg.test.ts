import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {postgresPublisherCredentials} from '@fss/social-publisher';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations} from '../../db/migrationRunner.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {readSocialStandingPublisherOptions} from '../../social/standingPlan.ts';
import {socialStandingOptionsSchema} from '@fss/contracts';

it('a migrated Chromium-only owner starts a new Buffer account and reconnects that native identity after disconnect without rewriting history',async()=>{
 const db=await createTestDatabase({throughVersion:166});try{
  const seed=await seedTwoWorkspaces(db.session),w=seed.alpha.workspaceId,u=seed.alpha.admin.userId,legacy=randomUUID();
  await db.session.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,adapter_version,verified_at,max_schedule_days) VALUES($1,$2,$3,'linkedin','https://www.linkedin.com/in/legacy-owner','Legacy owner','profile','connected','linkedin-web-chromium-v1',clock_timestamp(),30)",[w,legacy,u]);
  await db.session.query("INSERT INTO social_publisher_sessions(workspace_id,id,owner_user_id,account_id,account_revision,external_id,encrypted_state,state,verified_at,expires_at) VALUES($1,$2,$3,$4,1,'https://www.linkedin.com/in/legacy-owner',$5,'usable',clock_timestamp(),clock_timestamp()+interval '7 days')",[w,randomUUID(),u,legacy,Buffer.alloc(29,17)]);
  const historical=(await db.session.query('SELECT * FROM social_publisher_sessions')).rows;
  await applyMigrations(db.session,{throughVersion:167});
  const runtime=await db.appRuntimeSession(),owner=repositoryContext(workspaceScope(w,{kind:'user',userId:u,role:'admin'}),runtime);
  expect(await withTransaction(runtime,()=>readSocialStandingPublisherOptions(owner))).toEqual({binding:null,intendedAccountId:null,accountDisplayName:null});
  const providerDb=await db.appRuntimeSession(),credentials=postgresPublisherCredentials(providerDb,Buffer.alloc(32,17)),accountId=randomUUID(),identity={organizationId:'1'.repeat(24),channelId:'2'.repeat(24),externalId:'native-linkedin-service-id',displayName:'David fixture'};
  const binding=await credentials.save({workspaceId:w,ownerUserId:u},accountId,identity,'fixture-key',async()=>{});
  const options=await withTransaction(runtime,()=>readSocialStandingPublisherOptions(owner));
  expect(options).toEqual({binding,intendedAccountId:accountId,accountDisplayName:'David fixture'});
  expect(socialStandingOptionsSchema.parse({...options,calibrationId:null,guideRef:null,inputIds:[]})).toMatchObject({accountDisplayName:'David fixture'});
  await credentials.disconnect({workspaceId:w,ownerUserId:u},accountId,async()=>{});
  expect(await withTransaction(runtime,()=>readSocialStandingPublisherOptions(owner))).toEqual({binding:null,intendedAccountId:accountId,accountDisplayName:'David fixture'});
  const reconnected=await credentials.save({workspaceId:w,ownerUserId:u},accountId,identity,'replacement-key',async()=>{});
  expect(await withTransaction(runtime,()=>readSocialStandingPublisherOptions(owner))).toEqual({binding:reconnected,intendedAccountId:accountId,accountDisplayName:'David fixture'});
  expect((await db.session.query('SELECT external_id,adapter_version FROM social_accounts WHERE workspace_id=$1 AND id=$2',[w,legacy])).rows).toEqual([{external_id:'https://www.linkedin.com/in/legacy-owner',adapter_version:'linkedin-web-chromium-v1'}]);
  expect((await db.session.query('SELECT * FROM social_publisher_sessions')).rows).toEqual(historical);
 }finally{await db.drop();}
});
