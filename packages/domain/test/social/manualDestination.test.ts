import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {readSocialWorkspace} from '../../social/posts.ts';
import {saveSocialConnection} from '../../social/accounts.ts';
import {registerSocialManualDestination} from '../../social/manualDestination.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=(beta=false)=>{const s=beta?seed.beta:seed.alpha;return repositoryContext(workspaceScope(s.workspaceId,{kind:'user',userId:s.admin.userId,role:'admin'}),db.session);};
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
it('records a human supplied LinkedIn identity as unsupported rather than granting a native adapter',async()=>{
 const accountId=randomUUID();expect(await tx(()=>registerSocialManualDestination(ctx(),{accountId,platform:'linkedin',externalId:'reviewed-founder',displayName:'Founder',accountKind:'profile'}))).toEqual({ok:true,value:{accountId,state:'unsupported'}});
 expect((await readSocialWorkspace(ctx())).accounts.find(account=>account.id===accountId)).toMatchObject({state:'unsupported',adapterVersion:null,verifiedAt:null});
});

it('requires a Facebook Page and never overwrites a connected native destination',async()=>{
 const accountId=randomUUID();expect(await tx(()=>registerSocialManualDestination(ctx(),{accountId,platform:'facebook',externalId:'page',displayName:'Page',accountKind:'profile'}))).toEqual({ok:false,reason:'facebook_page_required'});
 const native={accountId,platform:'linkedin' as const,externalId:'native-founder',displayName:'Founder',accountKind:'profile' as const};await tx(()=>saveSocialConnection(ctx(),native));
 expect(await tx(()=>registerSocialManualDestination(ctx(),native))).toEqual({ok:false,reason:'destination_already_connected'});
 expect((await readSocialWorkspace(ctx())).accounts.find(account=>account.id===accountId)).toMatchObject({state:'connected',adapterVersion:'linkedin-native-v1'});
});

it('scopes manual identities to their owner and refuses reinterpretation or duplicate accounts',async()=>{
 const input={accountId:randomUUID(),platform:'x' as const,externalId:'manual-founder',displayName:'Founder',accountKind:'profile' as const};await tx(()=>registerSocialManualDestination(ctx(),input));
 expect(await tx(()=>registerSocialManualDestination(ctx(),{...input,externalId:'other-founder'}))).toEqual({ok:false,reason:'account_identity_changed'});
 expect(await tx(()=>registerSocialManualDestination(ctx(),{...input,accountId:randomUUID()}))).toEqual({ok:false,reason:'account_already_registered'});
 expect((await readSocialWorkspace(ctx(true))).accounts.some(account=>account.id===input.accountId)).toBe(false);
});
