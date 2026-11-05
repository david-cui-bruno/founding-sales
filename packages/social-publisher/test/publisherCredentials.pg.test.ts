import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../../domain/test/db/support/fixtures.ts';
import {postgresPublisherCredentials,type PublisherCredentialStore} from '../src/publisherCredentials.ts';
let db:TestDatabase,seed:TwoWorkspaces,store:PublisherCredentialStore;
const identity={organizationId:'a'.repeat(24),channelId:'b'.repeat(24),externalId:'native-linkedin-profile',displayName:'Owner'},apiKey='fixture-private-key';
const authority=async()=>{};
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);store=postgresPublisherCredentials(db.session,Buffer.alloc(32,5));});
afterAll(async()=>db.drop());
it('encrypts API keys without invented expiry and fences replacement credentials and disconnect',async()=>{
 const owner={workspaceId:seed.alpha.workspaceId,ownerUserId:seed.alpha.admin.userId},accountId=randomUUID();
 const first=await store.save(owner,accountId,identity,apiKey,authority);expect(await store.read(first)).toBe(apiKey);
 const row=(await db.session.query<{encrypted_state:Buffer}>('SELECT encrypted_state FROM social_publisher_credentials WHERE workspace_id=$1 AND account_id=$2',[owner.workspaceId,accountId])).rows[0];expect(row?.encrypted_state.toString()).not.toContain(apiKey);
 const replacement=await store.save(owner,accountId,identity,'replacement-fixture-key',authority);expect(replacement.accountRevision).toBe(first.accountRevision+1);expect(await store.read(first)).toBeNull();expect(await store.read(replacement)).toBe('replacement-fixture-key');
 expect(await store.read({...replacement,channelId:'c'.repeat(24)})).toBeNull();expect(await store.read({...replacement,organizationId:'c'.repeat(24)})).toBeNull();expect(await store.read({...replacement,ownerUserId:seed.beta.admin.userId})).toBeNull();
 await store.disconnect(owner,accountId,authority);expect(await store.read(replacement)).toBeNull();expect((await db.session.query('SELECT encrypted_state,state FROM social_publisher_credentials WHERE workspace_id=$1 AND account_id=$2',[owner.workspaceId,accountId])).rows[0]).toEqual({encrypted_state:null,state:'disconnected'});
});
it('rolls back encrypted credential and account allocation when retained authority changes',async()=>{
 const owner={workspaceId:seed.alpha.workspaceId,ownerUserId:seed.alpha.admin.userId},accountId=randomUUID();
 await expect(store.save(owner,accountId,{...identity,externalId:'rollback-profile'},apiKey,async()=>{throw new Error('principal_changed');})).rejects.toThrow('principal_changed');expect((await db.session.query('SELECT 1 FROM social_accounts WHERE workspace_id=$1 AND id=$2',[owner.workspaceId,accountId])).rows).toHaveLength(0);
});
it('refuses wrong profile reconnect without changing the bound current credential',async()=>{
 const owner={workspaceId:seed.alpha.workspaceId,ownerUserId:seed.alpha.admin.userId},accountId=randomUUID(),profile={...identity,externalId:'revocation-profile'};
 const binding=await store.save(owner,accountId,profile,apiKey,authority);await expect(store.save(owner,accountId,{...profile,externalId:'foreign-profile'},apiKey,authority)).rejects.toThrow('publisher_account_mismatch');expect(await store.read(binding)).toBe(apiKey);
});
it('removes access and encrypted custody on active-owner departure',async()=>{
 const owner={workspaceId:seed.alpha.workspaceId,ownerUserId:seed.alpha.admin.userId},accountId=randomUUID();
 const binding=await store.save(owner,accountId,{...identity,externalId:'departing-profile'},apiKey,authority);
 await db.session.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT DO NOTHING",[owner.workspaceId,seed.beta.admin.userId]);
 try{await db.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[owner.workspaceId,owner.ownerUserId]);expect(await store.read(binding)).toBeNull();expect((await db.session.query('SELECT encrypted_state FROM social_publisher_credentials WHERE workspace_id=$1 AND account_id=$2',[owner.workspaceId,accountId])).rows[0]?.['encrypted_state']).toBeNull();}
 finally{await db.session.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[owner.workspaceId,owner.ownerUserId]);}
 expect(await store.read(binding)).toBeNull();
});
