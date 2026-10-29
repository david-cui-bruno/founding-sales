import {beforeEach,expect,it,vi} from 'vitest';
import type {RouteDeps} from '../src/routes/routeSupport.ts';
import type {AuthenticatedPrincipal} from '../src/auth/sessions.ts';
import type {AuthDeps} from '../src/auth/config.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {PrivateDraftAuthorityChanged} from '@fss/domain/social/privateDrafts.ts';
import {routeSocialPublishingReadiness,SOCIAL_PUBLISHING_READINESS_PATH} from '../src/routes/socialPublishingReadiness.ts';
const mocks=vi.hoisted(()=>({principal:vi.fn(),context:vi.fn(),read:vi.fn(),authority:vi.fn()}));
vi.mock('../src/routes/routeSupport.ts',()=>({contextForPrincipal:mocks.context,requirePrincipal:mocks.principal}));
vi.mock('../src/routes/retainedPrincipalAuthority.ts',()=>({retainedPrincipalAuthority:()=>mocks.authority}));
vi.mock('@fss/domain/social/publishingReadiness.ts',()=>({readSocialPublishingReadiness:mocks.read}));
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const principal:AuthenticatedPrincipal={workspaceId:id,userId:id,role:'admin',membershipStatus:'active',deviceId:id,deviceStatus:'active',sessionId:id};
const value={observedAt:'2026-10-29T12:00:00Z',runnerAvailable:false,publishingActivated:false,holds:['adapter_unavailable'],accounts:[]};
const db={query:vi.fn(async(_text:string,_values?:readonly unknown[])=>({rows:[],rowCount:0}))};
const unavailable=async():Promise<never>=>{throw Error('Provider access is unavailable in this controlled route test');};
const auth:AuthDeps={db,now:()=>new Date('2026-10-29T12:00:00Z'),randomSecret:()=>{throw Error('Unused secret port');},
 google:{discovery:unavailable,signingKey:unavailable,exchangeCode:unavailable,verifySignature:()=>false},
 config:{supportedClientVersions:{minimum:'1.0.0',ceiling:'1.x',incompatible:[]},
  sessions:{accessSessionSeconds:3600,fullSignInSeconds:86400,authorizationRequestSeconds:300},stateSigningKey:Buffer.alloc(32),
  oidc:{issuer:'https://fixture.invalid',discoveryUrl:'https://fixture.invalid/discovery',clientId:'fixture',clientSecret:'fixture-only',
   redirectUri:'https://fixture.invalid/callback',hostedDomain:'fixture.invalid',clockSkewSeconds:0}}};
// Only the boundary's auth/domain seams are controlled here; real signed requests
// are authored separately in the PG case and require Root's runtime allocation.
const deps:RouteDeps={auth,principal,
 request:{method:'POST',path:SOCIAL_PUBLISHING_READINESS_PATH,headers:{},query:new URLSearchParams(),body:{}}};
beforeEach(()=>{
 vi.clearAllMocks();mocks.principal.mockResolvedValue({ok:true,principal});mocks.authority.mockResolvedValue(true);
 mocks.context.mockReturnValue({ok:true,context:repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),db)});
 mocks.read.mockResolvedValue({ok:true,value});
});
it('passes only the exact private-principal context into a read transaction with no command receipt',async()=>{
 expect(await routeSocialPublishingReadiness(deps)).toEqual({status:200,body:value});
 expect(db.query.mock.calls.map(call=>call[0])).toEqual(['BEGIN','COMMIT']);
 expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({scope:expect.objectContaining({workspaceId:id})}),mocks.authority);
 expect(mocks.principal).toHaveBeenCalledTimes(2);
});
it.each(['userId','deviceId','sessionId','workspaceId','role'] as const)('withholds an assembled read when %s changes before final publication',async key=>{
 mocks.principal.mockResolvedValueOnce({ok:true,principal}).mockResolvedValueOnce({ok:true,principal:{...principal,[key]:key==='role'?'salesperson':other}});
 expect(await routeSocialPublishingReadiness(deps)).toEqual({status:401,body:{error:'unauthenticated'}});
});
it('maps after-wait retained authority refusal to unauthenticated with no metadata',async()=>{
 mocks.read.mockImplementation(async()=>{throw new PrivateDraftAuthorityChanged();});
 expect(await routeSocialPublishingReadiness(deps)).toEqual({status:401,body:{error:'unauthenticated'}});
 expect(db.query.mock.calls.map(call=>call[0])).toEqual(['BEGIN','ROLLBACK']);
});
it('rejects write-like inputs, other methods and domain scope refusals',async()=>{
 expect((await routeSocialPublishingReadiness({...deps,request:{...deps.request,body:{activate:true}}})).status).toBe(400);
 expect((await routeSocialPublishingReadiness({...deps,request:{...deps.request,method:'GET'}})).status).toBe(405);
 expect(mocks.read).not.toHaveBeenCalled();mocks.read.mockResolvedValue({ok:false,reason:'owner_unavailable'});
 expect(await routeSocialPublishingReadiness(deps)).toEqual({status:403,body:{error:'publishing_readiness_unavailable'}});
});
