import {beforeEach,it,expect,vi} from 'vitest';
import type {AuthenticatedPrincipal} from '../src/auth/sessions.ts';
import type {AuthDeps} from '../src/auth/config.ts';
import type {RouteDeps} from '../src/routes/routeSupport.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {routeSocialPublisherConnection,SOCIAL_PUBLISHER_CONNECTION_PATH} from '../src/routes/socialPublisher.ts';
import type {SocialPublisherConnectionInput,SocialPublisherConnectionResult} from '@fss/contracts';
import type {PublisherConnectionOwner} from '@fss/social-publisher';
import {PublisherRefusal} from '@fss/social-publisher';
import {samePrivatePrincipal} from '../src/routes/privateReadAuthority.ts';
const mocks=vi.hoisted(()=>({principal:vi.fn<()=>Promise<{ok:boolean;principal:AuthenticatedPrincipal}>>(),context:vi.fn()}));
vi.mock('../src/routes/routeSupport.ts',()=>({contextForPrincipal:mocks.context,requirePrincipal:mocks.principal}));
vi.mock('../src/routes/retainedPrincipalAuthority.ts',()=>({retainedPrincipalAuthority:(deps:RouteDeps)=>async()=>{const current=await mocks.principal();return current.ok&&samePrivatePrincipal(deps.principal,current.principal);}}));
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const principal:AuthenticatedPrincipal={workspaceId:id,userId:id,role:'admin',membershipStatus:'active',deviceId:id,deviceStatus:'active',sessionId:id};
const query=vi.fn(async(_text:string,_values?:readonly unknown[])=>({rows:[],rowCount:1}));
const unavailable=async():Promise<never>=>{throw new Error('unused_provider');};
const auth:AuthDeps={db:{query},now:()=>new Date(),randomSecret:()=>{throw new Error('unused_secret');},google:{discovery:unavailable,signingKey:unavailable,exchangeCode:unavailable,verifySignature:()=>false},config:{supportedClientVersions:{minimum:'1.0.0',ceiling:'1.x',incompatible:[]},sessions:{accessSessionSeconds:3600,fullSignInSeconds:86400,authorizationRequestSeconds:300},stateSigningKey:Buffer.alloc(32),oidc:{issuer:'https://fixture.invalid',discoveryUrl:'https://fixture.invalid/discovery',clientId:'fixture',clientSecret:'fixture',redirectUri:'https://fixture.invalid/callback',hostedDomain:'fixture.invalid',clockSkewSeconds:0}}};
const request:RouteDeps={auth,principal,request:{method:'POST',path:SOCIAL_PUBLISHER_CONNECTION_PATH,headers:{},query:new URLSearchParams(),body:{operation:'discover',apiKey:'private-fixture-key'}}};
const connection=vi.fn(async(_owner:PublisherConnectionOwner,_input:SocialPublisherConnectionInput,authority:()=>Promise<void>):Promise<SocialPublisherConnectionResult>=>{await authority();return {state:'channels',channels:[]};});
beforeEach(()=>{vi.clearAllMocks();mocks.principal.mockResolvedValue({ok:true,principal});mocks.context.mockReturnValue({ok:true,context:repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),auth.db)});});
it.each(['workspaceId','userId','deviceId','sessionId','role'] as const)('withholds discovery after retained %s changes across vendor wait',async field=>{
 mocks.principal.mockResolvedValueOnce({ok:true,principal}).mockResolvedValueOnce({ok:true,principal:{...principal,[field]:field==='role'?'salesperson':other}});
 expect(await routeSocialPublisherConnection(request,{connection})).toEqual({status:401,body:{error:'unauthenticated'}});
});
it('rejects supplied provider identity, credential imports and retired browser operations',async()=>{
 for(const body of [{operation:'connect',accountId:id,apiKey:'fixture',organizationId:'a'.repeat(24),channelId:'b'.repeat(24),externalId:'foreign'},{operation:'discover',apiKey:'fixture',cookies:'private'},{operation:'start',accountId:id},{operation:'input',connectionId:id,event:{kind:'text',text:'private'}}])expect((await routeSocialPublisherConnection({...request,request:{...request.request,body}},{connection})).status).toBe(400);
 expect(connection).not.toHaveBeenCalled();
});
it('never returns credential-bearing vendor exceptions or invalidates app authentication',async()=>{
 const failing={connection:async():Promise<never>=>{throw new Error('private-fixture-key upstream secret');}};
 expect(await routeSocialPublisherConnection(request,failing)).toEqual({status:503,body:{error:'connection_unavailable'}});
 expect((await routeSocialPublisherConnection(request,undefined)).status).toBe(503);
});
it('passes only retained principal ownership and keeps credentials out of SQL',async()=>{
 expect(await routeSocialPublisherConnection(request,{connection})).toEqual({status:200,body:{state:'channels',channels:[]}});
 expect(connection.mock.calls[0]?.[0]).toEqual({workspaceId:id,ownerUserId:id,sessionId:id,deviceId:id});
 expect(query.mock.calls.flat().join(' ')).not.toContain('private-fixture-key');
});
it.each(['credential_revoked','publisher_account_mismatch','queue_paused','channel_permission_denied'])('keeps %s in connection recovery instead of app-auth logout',async reason=>{
 expect(await routeSocialPublisherConnection(request,{connection:async()=>{throw new PublisherRefusal(reason);}})).toEqual({status:503,body:{error:reason}});
});
it('bounds provider throttling without retry',async()=>{const refusal=vi.fn(async():Promise<never>=>{throw new PublisherRefusal('provider_rate_limited');});expect((await routeSocialPublisherConnection(request,{connection:refusal})).status).toBe(429);expect(refusal).toHaveBeenCalledTimes(1);});
it.each([true,false])('preserves principal-loss handling during typed=%s vendor failure',async typed=>{
 const refusing={connection:async():Promise<never>=>{mocks.principal.mockResolvedValue({ok:false,principal});throw typed?new PublisherRefusal('credential_revoked'):new Error('transport_lost');}};
 expect(await routeSocialPublisherConnection(request,refusing)).toEqual({status:401,body:{error:'unauthenticated'}});
});
