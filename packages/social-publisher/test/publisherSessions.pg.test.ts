import {beforeEach,afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../../domain/test/db/support/fixtures.ts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {postgresPublisherSessions} from '../src/publisherSessions.ts';
import {expireSocialPublisherSessions} from '@fss/domain/social/publisherSessionCleanup.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readSocialPublishingReadiness} from '@fss/domain/social/publishingReadiness.ts';
import {SOCIAL_BROWSER_ADAPTER} from '@fss/contracts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
beforeEach(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterEach(async()=>{await db?.drop();});
const key=Buffer.alloc(32,37);
const authority=async()=>{};
const state=JSON.stringify({cookies:[{name:'fictional',value:'private-cookie-fixture'}],origins:[]});
it('app_runtime saves only encrypted credentials and exact immutable owner/account/session binding',async()=>{
 const store=postgresPublisherSessions(runtime,key),owner={workspaceId:seed.alpha.workspaceId,ownerUserId:seed.alpha.admin.userId},accountId=randomUUID();
 const binding=await store.save(owner,accountId,{externalId:'https://www.linkedin.com/in/fixture-owner',displayName:'Fictional owner'},state,authority);
 expect(await store.read(binding)).toBe(state);
 const row=(await db.session.query<{encrypted_state:Buffer;state:string}>('SELECT encrypted_state,state FROM social_publisher_sessions WHERE workspace_id=$1 AND id=$2',[binding.workspaceId,binding.sessionId])).rows[0]!;
 expect(row.state).toBe('usable');expect(row.encrypted_state.includes(Buffer.from('private-cookie-fixture'))).toBe(false);
 expect(await store.read({...binding,ownerUserId:seed.alpha.salesperson.userId})).toBeNull();
 expect(await store.read({...binding,workspaceId:seed.beta.workspaceId})).toBeNull();
 expect(await store.read({...binding,accountRevision:binding.accountRevision+1})).toBeNull();
 expect(await store.read({...binding,sessionRevision:binding.sessionRevision+1})).toBeNull();
 const next=await store.save(owner,accountId,{externalId:binding.externalId,displayName:'Fictional owner'},state,authority);
 expect(next.accountRevision).toBe(binding.accountRevision+1);expect(next.sessionId).not.toBe(binding.sessionId);expect(await store.read(binding)).toBeNull();
 expect(await store.read(next)).toBe(state);
});
it('refuses renderer-like account replacement and rolls back account/session after authority loss',async()=>{
 const store=postgresPublisherSessions(runtime,key),owner={workspaceId:seed.alpha.workspaceId,ownerUserId:seed.alpha.admin.userId};
 const binding=await store.save(owner,randomUUID(),{externalId:'https://www.linkedin.com/in/fixture-owner',displayName:'Fictional owner'},state,authority);
 await expect(store.save(owner,binding.accountId,{externalId:'https://www.linkedin.com/in/other-owner',displayName:'Different owner'},state,authority)).rejects.toThrow('publisher_account_mismatch');
 let checks=0;
 await expect(store.save(owner,binding.accountId,{externalId:binding.externalId,displayName:'Fictional owner'},state,async()=>{if(++checks===2)throw new Error('revoked');})).rejects.toThrow('revoked');
 expect(await store.read(binding)).toBe(state);
});
it('disconnect and owner departure physically erase sessions without deleting remote-delivery history',async()=>{
 const store=postgresPublisherSessions(runtime,key),owner={workspaceId:seed.alpha.workspaceId,ownerUserId:seed.alpha.admin.userId};
 const binding=await store.save(owner,randomUUID(),{externalId:'https://www.linkedin.com/in/fixture-owner',displayName:'Fictional owner'},state,authority);
 await store.disconnect(owner,binding.accountId,authority);expect(await store.read(binding)).toBeNull();
 expect((await db.session.query('SELECT encrypted_state,state FROM social_publisher_sessions WHERE workspace_id=$1 AND id=$2',[binding.workspaceId,binding.sessionId])).rows).toEqual([{encrypted_state:null,state:'disconnected'}]);
 const reconnected=await store.save(owner,binding.accountId,{externalId:binding.externalId,displayName:'Fictional owner'},state,authority);
 await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[owner.workspaceId,seed.alpha.salesperson.userId]);
 await db.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[owner.workspaceId,owner.ownerUserId]);
 expect(await store.read(reconnected)).toBeNull();
 expect((await db.session.query('SELECT encrypted_state,state FROM social_publisher_sessions WHERE workspace_id=$1 AND id=$2',[reconnected.workspaceId,reconnected.sessionId])).rows).toEqual([{encrypted_state:null,state:'disconnected'}]);
 expect((await db.session.query('SELECT count(*)::integer AS n FROM social_accounts WHERE workspace_id=$1 AND id=$2',[owner.workspaceId,binding.accountId])).rows).toEqual([{n:1}]);
});
it('persists independent API and worker browser observations without one overwriting the other',async()=>{
 const store=postgresPublisherSessions(runtime,key);
 await store.heartbeat('worker','worker-fixture-version');await store.heartbeat('api','api-fixture-version');
 const worker=(await runtime.query("SELECT * FROM social_publisher_runtime WHERE execution_side='worker'")).rows;
 await store.heartbeat('api','new-api-fixture-version');
 expect((await runtime.query("SELECT * FROM social_publisher_runtime WHERE execution_side='worker'")).rows).toEqual(worker);
 expect((await runtime.query<{execution_side:string;chromium_version:string;bounded:boolean}>("SELECT execution_side,chromium_version,expires_at<=observed_at+interval '90 seconds' AS bounded FROM social_publisher_runtime ORDER BY execution_side")).rows).toEqual([
  {execution_side:'api',chromium_version:'new-api-fixture-version',bounded:true},
  {execution_side:'worker',chromium_version:'worker-fixture-version',bounded:true},
 ]);
});
it('never advertises unattended availability from healthy API/browser verification with absent or stale worker execution',async()=>{
 const store=postgresPublisherSessions(runtime,key),owner={workspaceId:seed.alpha.workspaceId,ownerUserId:seed.alpha.admin.userId};
 const binding=await store.save(owner,randomUUID(),{externalId:'https://www.linkedin.com/in/fixture-owner',displayName:'Fictional owner'},state,authority);
 const ctx=repositoryContext(workspaceScope(owner.workspaceId,{kind:'user',role:'admin',userId:owner.ownerUserId}),runtime);
 const verification={verify:async()=>({usable:true,externalId:binding.externalId,adapter:SOCIAL_BROWSER_ADAPTER})};
 await store.heartbeat('api','healthy-api-fixture-version');
 expect(await withTransaction(runtime,()=>readSocialPublishingReadiness(ctx,async()=>true,verification))).toMatchObject({ok:true,value:{runnerAvailable:false,holds:expect.arrayContaining(['adapter_unavailable']),accounts:[{currentAccountVerified:true}]}});
 await store.heartbeat('worker','healthy-worker-fixture-version');
 expect(await withTransaction(runtime,()=>readSocialPublishingReadiness(ctx,async()=>true,verification))).toMatchObject({ok:true,value:{runnerAvailable:true,accounts:[{currentAccountVerified:true}]}});
 await runtime.query("UPDATE social_publisher_runtime SET observed_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE execution_side='worker'");
 await store.heartbeat('api','still-healthy-api-fixture-version');
 expect(await withTransaction(runtime,()=>readSocialPublishingReadiness(ctx,async()=>true,verification))).toMatchObject({ok:true,value:{runnerAvailable:false,holds:expect.arrayContaining(['adapter_unavailable']),accounts:[{currentAccountVerified:true}]}});
 await store.heartbeat('worker','recovered-worker-fixture-version');
 expect(await withTransaction(runtime,()=>readSocialPublishingReadiness(ctx,async()=>true))).toMatchObject({ok:true,value:{runnerAvailable:true,holds:expect.arrayContaining(['current_account_unverified']),accounts:[{currentAccountVerified:false}]}});
});
it('physically erases expired credentials through the existing worker sweep without renewing identity',async()=>{
 const store=postgresPublisherSessions(runtime,key),owner={workspaceId:seed.alpha.workspaceId,ownerUserId:seed.alpha.admin.userId};
 const binding=await store.save(owner,randomUUID(),{externalId:'https://www.linkedin.com/in/fixture-owner',displayName:'Fictional owner'},state,authority);
 await db.session.query("UPDATE social_publisher_sessions SET verified_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' WHERE workspace_id=$1 AND id=$2",[binding.workspaceId,binding.sessionId]);
 expect(await store.read(binding)).toBeNull();
 const ctx=repositoryContext(workspaceScope(owner.workspaceId,{kind:'system',component:'worker'}),runtime);
 expect(await withTransaction(runtime,()=>expireSocialPublisherSessions(ctx))).toBe(1);
 expect((await runtime.query('SELECT encrypted_state,state FROM social_publisher_sessions WHERE workspace_id=$1 AND id=$2',[binding.workspaceId,binding.sessionId])).rows).toEqual([{encrypted_state:null,state:'expired'}]);
 expect(await withTransaction(runtime,()=>expireSocialPublisherSessions(ctx))).toBe(0);
});
