import {beforeEach,expect,it,vi} from 'vitest';
import type {RouteDeps} from '../src/routes/routeSupport.ts';
import type * as RouteSupport from '../src/routes/routeSupport.ts';
import {routeQualifiedResearch} from '../src/routes/qualifiedResearch.ts';
const mocks=vi.hoisted(()=>({command:vi.fn(),read:vi.fn(),authority:vi.fn(),context:vi.fn()}));
vi.mock('../src/auth/commands.ts',()=>({runCommand:mocks.command}));
vi.mock('@fss/domain/sourcing/qualifiedResearch.ts',()=>({createQualifiedResearchFirm:vi.fn(),listQualifiedResearchCandidates:vi.fn(),readQualifiedResearchFirm:mocks.read}));
vi.mock('@fss/domain/db/queryable.ts',()=>({withTransaction:async(_db:unknown,work:()=>Promise<unknown>)=>work()}));
vi.mock('../src/routes/routeSupport.ts',async importOriginal=>({
 ...await importOriginal<typeof RouteSupport>(),
 contextForPrincipal:mocks.context,
 requirePrincipal:mocks.authority,
}));
const firmId='00000000-0000-4000-8000-000000000001';
const principal={workspaceId:firmId,userId:firmId,role:'admin',membershipStatus:'active',deviceId:firmId,deviceStatus:'active',sessionId:firmId};
const payload={discoveryCandidateId:firmId,discoveryRevision:1,candidateId:firmId,candidateRevision:1,runId:firmId};
const deps={auth:{db:{}},principal,request:{method:'POST',path:'/sourcing/research-firms/create',headers:{authorization:'Bearer synthetic'},body:{...payload,commandId:firmId,clientVersion:'1.0.0'}}} as unknown as RouteDeps;
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.context.mockReturnValue({ok:true,context:{db:{},scope:{}}});
 mocks.read.mockResolvedValue(null);
 mocks.authority.mockResolvedValue({ok:true,principal});
});
it.each([false,true])('accepted receipt replayed=%s with unavailable proof returns only 404, preserving the receipt',async replayed=>{
 const receipt=Object.freeze({status:'accepted',result:Object.freeze({firmId}),replayed});
 mocks.command.mockResolvedValue(receipt);
 expect(await routeQualifiedResearch(deps)).toEqual({status:404,body:{error:'research_firm_unavailable'}});
 expect(receipt).toEqual({status:'accepted',result:{firmId},replayed});
 expect(mocks.read).toHaveBeenCalledExactlyOnceWith(expect.anything(),firmId);
 expect(mocks.command).toHaveBeenCalledExactlyOnceWith(deps.auth,principal,{commandId:firmId,clientVersion:'1.0.0',kind:'sourcing.qualified_research_firm',payload},expect.any(Function));
});
it.each([false,true])('accepted receipt replayed=%s with lost current authority returns only 401',async replayed=>{
 mocks.command.mockResolvedValue({status:'accepted',result:{firmId},replayed});
 mocks.authority.mockResolvedValue({ok:false,result:{status:401,body:{error:'session_expired'}}});
 expect(await routeQualifiedResearch(deps)).toEqual({status:401,body:{error:'unauthenticated'}});
});
it('withholds current proof and canonical identity when current principal changes',async()=>{
 mocks.command.mockResolvedValue({status:'accepted',result:{firmId},replayed:true});
 mocks.read.mockResolvedValue({firmId,citations:[{quote:'Private proof must not escape'}]});
 mocks.authority.mockResolvedValue({ok:true,principal:{...principal,userId:'00000000-0000-4000-8000-000000000002'}});
 expect(await routeQualifiedResearch(deps)).toEqual({status:401,body:{error:'unauthenticated'}});
});
