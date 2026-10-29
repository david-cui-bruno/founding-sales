import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {readSocialPublishingReadiness} from '../../social/publishingReadiness.ts';
import {PrivateDraftAuthorityChanged} from '../../social/privateDrafts.ts';
let db:TestDatabase,runtime:SessionQueryable,seed:TwoWorkspaces;
beforeEach(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterEach(async()=>db?.drop());
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
async function account(workspace:string,owner:string,platform='linkedin',kind='profile'){
 const id=randomUUID();await db.session.query(`INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,revision,adapter_version,verified_at)
 VALUES($1,$2,$3,$4,$5,'Fictional historical account',$6,'connected',7,'legacy-adapter-marker',now())`,[workspace,id,owner,platform,id,kind]);return id;
}
async function noEffects(){
 for(const table of ['social_posts','social_post_approvals','social_deliveries','jobs','outbound_messages','command_receipts','provider_reservations'])
  expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
}
it('app_runtime reads only its exact owner while historical connected and unsupported routes remain blocked',async()=>{
 const own=await account(seed.alpha.workspaceId,seed.alpha.admin.userId);
 await account(seed.alpha.workspaceId,seed.alpha.salesperson.userId);await account(seed.beta.workspaceId,seed.beta.admin.userId);
 const facebook=await account(seed.alpha.workspaceId,seed.alpha.admin.userId,'facebook','page');
 const before=(await db.session.query('SELECT * FROM social_accounts ORDER BY id')).rows;
 const result=await withTransaction(runtime,()=>readSocialPublishingReadiness(ctx(),async()=>true));
 expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);
 expect(result.value.accounts.map(row=>row.accountId).sort()).toEqual([own,facebook].sort());
 expect(result.value.accounts.find(row=>row.accountId===own)).toMatchObject({historicalState:'connected',revision:7,currentAccountVerified:false});
 expect(result.value.accounts.find(row=>row.accountId===facebook)?.holds).toContain('unsupported_route');
 expect(result.value.publishingActivated).toBe(false);expect(result.value.runnerAvailable).toBe(false);
 expect(JSON.stringify(result.value)).not.toMatch(/legacy-adapter-marker|externalId|verifiedAt|ownerUserId/u);
 expect((await db.session.query('SELECT * FROM social_accounts ORDER BY id')).rows).toEqual(before);await noEffects();
});
it('metadata read returns no projection after final authority loss',async()=>{
 await account(seed.alpha.workspaceId,seed.alpha.admin.userId);let checks=0;
 await expect(withTransaction(runtime,()=>readSocialPublishingReadiness(ctx(),async()=>++checks===1))).rejects.toBeInstanceOf(PrivateDraftAuthorityChanged);
 await noEffects();
});
it('overflow is refused instead of selecting or modifying one of more than thirty accounts',async()=>{
 for(let i=0;i<31;i++)await account(seed.alpha.workspaceId,seed.alpha.admin.userId);
 expect(await withTransaction(runtime,()=>readSocialPublishingReadiness(ctx(),async()=>true))).toEqual({ok:false,reason:'account_limit_exceeded'});await noEffects();
});
