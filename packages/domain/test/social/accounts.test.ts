import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveSocialConnection,disconnectSocialAccount} from '../../social/accounts.ts';
import {readSocialWorkspace} from '../../social/posts.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=(beta=false)=>{const s=beta?seed.beta:seed.alpha;return repositoryContext(workspaceScope(s.workspaceId,{kind:'user',userId:s.admin.userId,role:'admin'}),db.session);};
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
const connection=()=>({accountId:randomUUID(),platform:'linkedin' as const,externalId:`profile-${randomUUID()}`,displayName:'Fixture founder',accountKind:'profile' as const});
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
it('enables the shipped LinkedIn scheduler for an observed identity',async()=>{
 const input=connection();expect(await tx(()=>saveSocialConnection(ctx(),input))).toMatchObject({ok:true,value:{accountId:input.accountId,state:'connected'}});
 const a=(await readSocialWorkspace(ctx())).accounts.find(v=>v.id===input.accountId);expect(a).toMatchObject({state:'connected',adapterVersion:'linkedin-native-v1',verifiedAt:expect.any(String)});
 expect(await tx(()=>saveSocialConnection(ctx(),{...input,externalId:'different-person'}))).toEqual({ok:false,reason:'account_identity_changed'});
});
it('does not conflate a duplicate identity with a new local cookie partition',async()=>{
 const input=connection();await tx(()=>saveSocialConnection(ctx(),input));
 expect(await tx(()=>saveSocialConnection(ctx(),{...input,accountId:randomUUID()}))).toEqual({ok:false,reason:'account_already_connected'});
});
it('rejects Facebook personal profiles and scopes disconnect to the owner workspace',async()=>{
 expect(await tx(()=>saveSocialConnection(ctx(),{...connection(),platform:'facebook'}))).toEqual({ok:false,reason:'facebook_page_required'});
 const input=connection();await tx(()=>saveSocialConnection(ctx(),input));
 expect(await tx(()=>disconnectSocialAccount(ctx(true),{accountId:input.accountId}))).toEqual({ok:false,reason:'not_found'});
 expect(await tx(()=>disconnectSocialAccount(ctx(),{accountId:input.accountId}))).toMatchObject({ok:true,value:{state:'disconnected'}});
 expect((await readSocialWorkspace(ctx())).accounts.find(a=>a.id===input.accountId)?.state).toBe('disconnected');
});
