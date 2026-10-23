import {beforeEach,expect,it,vi} from 'vitest';
import {clientVersionPolicySchema} from '@fss/contracts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import type {RoutingOptions} from '../src/routes/types.ts';
import type {RouteDeps} from '../src/routes/routeSupport.ts';
import type * as RouteSupport from '../src/routes/routeSupport.ts';
import {routeCandidateAuthority,CANDIDATE_AUTHORITY_PATH} from '../src/routes/candidateAuthority.ts';
import {routeSourcing,SOURCING_PATHS} from '../src/routes/sourcing.ts';
const mocks=vi.hoisted(()=>({read:vi.fn(),authority:vi.fn(),context:vi.fn(),list:vi.fn()}));
vi.mock('@fss/domain/sourcing/candidateAuthority.ts',()=>({readCandidateAuthority:mocks.read}));
vi.mock('@fss/domain/sourcing/candidates.ts',()=>({listCandidates:mocks.list,saveCandidate:vi.fn(),reviewCandidate:vi.fn(),deleteCandidate:vi.fn()}));
vi.mock('../src/routes/routeSupport.ts',async importOriginal=>({...await importOriginal<typeof RouteSupport>(),contextForPrincipal:mocks.context,requirePrincipal:mocks.authority}));
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const principal={workspaceId:id,userId:id,role:'admin',membershipStatus:'active',deviceId:id,deviceStatus:'active',sessionId:id};
const view={candidateId:id,candidateRevision:1,checkedAt:'2026-10-23T16:00:00.000Z',source:{status:'unavailable'},owner:'unavailable',researchEnabled:true,holds:'unknown',authority:'not_granted'};
function options():RoutingOptions{return {auth:deps.auth,session:deps.auth.db,supportedClientVersions:clientVersionPolicySchema.parse({minimum:'1.0.0',ceiling:'1.0.x',incompatible:[]}),sendingEnabled:false,upgradeUrl:'https://example.test/upgrade',suppressionJournal:localNoopSuppressionJournal()};}
let deps:RouteDeps,sql:string[];
beforeEach(()=>{
 vi.clearAllMocks();sql=[];
 deps={auth:{db:{query:async(text:string)=>{sql.push(text);return {rows:[],rowCount:0};}}},principal,request:{method:'POST',path:CANDIDATE_AUTHORITY_PATH,headers:{authorization:'Bearer synthetic'},body:{candidateId:id,expectedRevision:1}}} as unknown as RouteDeps;
 mocks.context.mockReturnValue({ok:true,context:{db:deps.auth.db,scope:{actor:{kind:'user',role:'admin',userId:id},workspaceId:id}}});
 mocks.read.mockResolvedValue({ok:true,value:view});mocks.authority.mockResolvedValue({ok:true,principal});
});
it('mounts the exact path, uses normal transaction and never falls through inventory',async()=>{
 expect(SOURCING_PATHS).toContain(CANDIDATE_AUTHORITY_PATH);
 expect(await routeSourcing(deps.request,options())).toEqual({status:200,body:view});
 expect(sql).toEqual(['BEGIN','COMMIT']);expect(mocks.list).not.toHaveBeenCalled();
 expect(mocks.read).toHaveBeenCalledExactlyOnceWith(expect.anything(),{candidateId:id,expectedRevision:1});
 expect(mocks.authority).toHaveBeenCalledTimes(2);
});
it.each([{candidateId:id,expectedRevision:1,extra:true},{candidateId:id,expectedRevision:0},{candidateId:'bad',expectedRevision:1},{}])('rejects malformed strict request %j before database read',async body=>{
 expect(await routeCandidateAuthority({...deps,request:{...deps.request,body}})).toEqual({status:400,body:{error:'malformed_body'}});
 expect(mocks.read).not.toHaveBeenCalled();expect(sql).toEqual([]);
});
it('refuses nonadmin and nonPOST before reading',async()=>{
 mocks.context.mockReturnValue({ok:true,context:{scope:{actor:{kind:'user',role:'salesperson'}}}});
 expect(await routeCandidateAuthority(deps)).toEqual({status:403,body:{error:'admin_only'}});
 expect(await routeSourcing({...deps.request,method:'GET'},options())).toEqual({status:405,body:{error:'method_not_allowed'}});
 expect(mocks.read).not.toHaveBeenCalled();
});
it.each(['workspaceId','userId','role','membershipStatus','deviceId','deviceStatus','sessionId'] as const)('withholds result after post-wait principal %s changes',async field=>{
 mocks.authority.mockResolvedValue({ok:true,principal:{...principal,[field]:field==='role'?'salesperson':other}});
 expect(await routeCandidateAuthority(deps)).toEqual({status:401,body:{error:'unauthenticated'}});expect(sql).toEqual(['BEGIN','COMMIT']);
});
it('withholds an awaited reader result when final session authentication fails',async()=>{
 mocks.read.mockImplementation(async()=>{mocks.authority.mockResolvedValue({ok:false,result:{status:401,body:{error:'expired'}}});return {ok:true,value:view};});
 expect(await routeCandidateAuthority(deps)).toEqual({status:401,body:{error:'unauthenticated'}});
});
it.each([['candidate_unavailable',404],['authority_changed',409],['admin_only',403]] as const)('maps %s to non-success without private output',async(reason,status)=>{
 mocks.read.mockResolvedValue({ok:false,reason});expect(await routeCandidateAuthority(deps)).toEqual({status,body:{error:reason}});
});
it('strictly validates response and rolls back domain errors without retries',async()=>{
 mocks.read.mockResolvedValue({ok:true,value:{...view,privateBinding:'must not escape'}});
 await expect(routeCandidateAuthority(deps)).rejects.toThrow();
 mocks.read.mockRejectedValue(new Error('controlled database failure'));
 await expect(routeCandidateAuthority(deps)).rejects.toThrow('controlled database failure');
 expect(sql).toEqual(['BEGIN','COMMIT','BEGIN','ROLLBACK']);expect(mocks.read).toHaveBeenCalledTimes(2);
});
