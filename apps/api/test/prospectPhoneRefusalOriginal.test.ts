import {beforeEach,expect,it,vi} from 'vitest';
import {PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH,prospectPhoneRefusalOriginalSchema} from '@fss/contracts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import type {AuthDeps} from '../src/auth/config.ts';
import type {AuthenticatedPrincipal} from '../src/auth/sessions.ts';
import type {RouteDeps} from '../src/routes/routeSupport.ts';
import {routeProspectPhoneDiscovery,routeProspectPhoneDiscoveryForPrincipal} from '../src/routes/prospectPhoneDiscovery.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
const mocks=vi.hoisted(()=>({read:vi.fn(),authenticate:vi.fn()}));
vi.mock('@fss/domain/sourcing/prospectPhoneRefusalOriginal.ts',()=>({readProspectPhoneRefusalOriginal:mocks.read}));
vi.mock('../src/auth/sessions.ts',()=>({authenticate:mocks.authenticate}));
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const principal:AuthenticatedPrincipal={workspaceId:id,userId:id,deviceId:id,sessionId:id,role:'admin',membershipStatus:'active',deviceStatus:'active'};
const input={candidateId:id,expectedRevision:1,runId:other,observationId:id,blockId:'whole',labelStart:0,labelEnd:5,reason:'unattached_label_content'};
let statements:string[]=[];
const db:SessionQueryable={query:async<Row>(sql:string)=>{statements.push(sql);return {rows:(sql.includes('FROM devices')||sql.includes('FROM sessions')?[{id}]:[]) as Row[],rowCount:1};}};
const unused=()=>{throw Error('Forbidden network');};
const auth:AuthDeps={db,now:()=>new Date(),randomSecret:unused,google:{discovery:unused,signingKey:unused,exchangeCode:unused,verifySignature:unused},config:{oidc:{issuer:'https://fixture.example.test',discoveryUrl:'https://fixture.example.test/discovery',clientId:'fixture',clientSecret:'fixture',redirectUri:'https://fixture.example.test/callback',hostedDomain:'example.test',clockSkewSeconds:0},sessions:{accessSessionSeconds:3600,fullSignInSeconds:3600,authorizationRequestSeconds:600},stateSigningKey:Buffer.alloc(32),supportedClientVersions:{minimum:'1.4.0',ceiling:'1.4.x',incompatible:[]}}};
const deps=(body:unknown=input,method='POST',actor=principal):RouteDeps=>({auth,principal:actor,request:{method,path:PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH,query:new URLSearchParams(),headers:{authorization:'Bearer fixture'},body}});
function response(){return prospectPhoneRefusalOriginalSchema.parse({candidateId:id,candidateRevision:1,location:{runId:other,observationId:id,blockId:'whole',url:'https://fixture.example.test/contact',retrievedAt:new Date().toISOString(),contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',label:'PHONE',labelStart:0,labelEnd:5,reason:'unattached_label_content',authority:{kind:'phone_discovery',runId:other,expiresAt:new Date(Date.now()+60000).toISOString()},lineage:{kind:'provider_original'}},text:'PHONE: retained <b>whole</b> tail',purpose:'manual_refusal_review',channelAuthority:'not_granted'});}
beforeEach(()=>{vi.clearAllMocks();statements=[];mocks.authenticate.mockResolvedValue({authenticated:true,principal});mocks.read.mockImplementation(async(_ctx:unknown,_input:unknown,authority:()=>Promise<boolean>)=>await authority()?{ok:true,value:response()}:{ok:false,reason:'authority_changed'});});
it('actual public router dispatches exact selected read in one transaction without command receipts or job writes',async()=>{
 const d=deps(),result=await routeProspectPhoneDiscovery(d.request,{session:db,auth,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.example.test/upgrade',suppressionJournal:localNoopSuppressionJournal()});
 expect(result?.status).toBe(200);expect(prospectPhoneRefusalOriginalSchema.safeParse(result?.body).success).toBe(true);
 expect(mocks.read).toHaveBeenCalledExactlyOnceWith(expect.anything(),input,expect.any(Function));expect(statements[0]).toBe('BEGIN');expect(statements.at(-1)).toBe('COMMIT');expect(statements.join(' ')).not.toMatch(/INSERT|UPDATE|jobs|receipts/u);
});
it.each([{url:'https://fixture.example.test/'},{commandId:other},{runId:'invalid'},{labelEnd:0},{reason:'other'}])('strict request refuses arbitrary selection shape %j before domain read',async change=>{
 expect((await routeProspectPhoneDiscoveryForPrincipal(deps({...input,...change}))).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();expect(statements).toEqual([]);
});
it('GET and nonadmin cannot read retained text',async()=>{
 expect((await routeProspectPhoneDiscoveryForPrincipal(deps(input,'GET'))).status).toBe(405);
 expect((await routeProspectPhoneDiscoveryForPrincipal(deps(input,'POST',{...principal,role:'salesperson'}))).status).toBe(403);expect(mocks.read).not.toHaveBeenCalled();
});
it.each(['source_changed','source_unavailable','candidate_changed','source_expired'])('domain %s returns no text',async reason=>{
 mocks.read.mockResolvedValue({ok:false,reason});expect(await routeProspectPhoneDiscoveryForPrincipal(deps())).toEqual({status:409,body:{error:reason}});
});
it('principal loss before read denies without calling domain',async()=>{
 mocks.authenticate.mockResolvedValue({authenticated:false,refusal:'session_ended'});expect(await routeProspectPhoneDiscoveryForPrincipal(deps())).toEqual({status:401,body:{error:'session_changed'}});expect(mocks.read).not.toHaveBeenCalled();
});
it('principal loss during domain waits erases text through the normal retained callback',async()=>{
 mocks.read.mockImplementation(async(_ctx:unknown,_input:unknown,authority:()=>Promise<boolean>)=>{mocks.authenticate.mockResolvedValue({authenticated:false,refusal:'session_ended'});return await authority()?{ok:true,value:response()}:{ok:false,reason:'authority_changed'};});
 expect(await routeProspectPhoneDiscoveryForPrincipal(deps())).toEqual({status:401,body:{error:'session_changed'}});
});
it('malformed domain output cannot expose text or commit',async()=>{
 mocks.read.mockResolvedValue({ok:true,value:{...response(),text:'wrong label'}});await expect(routeProspectPhoneDiscoveryForPrincipal(deps())).rejects.toThrow();expect(statements.at(-1)).toBe('ROLLBACK');
});
