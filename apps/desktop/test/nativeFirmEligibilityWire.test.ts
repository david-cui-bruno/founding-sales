import {expect,it,vi} from 'vitest';
import {createAuthedClient,type AccessSession} from '../src/main/authedClient.ts';
import {sourcingFirmQualificationHandlers} from '../src/main/sourcingFirmQualificationHandlers.ts';
import type {HttpSend} from '../src/main/apiClient.ts';
import {nativeId,nativeView} from './support/nativeFirmFixture.ts';
function fixture(accessToken:()=>Promise<AccessSession|null>=async()=>({token:'synthetic',generation:1})){
 let generation=1;const send=vi.fn<HttpSend>(async()=>({status:200,body:nativeView()})),onConnection=vi.fn(),onAuthRefusal=vi.fn();
 const api=createAuthedClient({baseUrl:'https://example.test',clientVersion:'test',accessToken,send,onConnection,onAuthRefusal});
 return {send,onConnection,onAuthRefusal,handler:sourcingFirmQualificationHandlers({api,generation:()=>generation})['sourcing.firmQualification'],change:()=>{generation++;}};
}
it('sends existing authenticated read with no receipt and carries additive native summary',async()=>{
 const f=fixture(),answer=await f.handler({firmId:nativeId});expect(answer.view?.nativeEligibility).toMatchObject({status:'verified',channelAuthority:'not_granted'});
 expect(JSON.parse(f.send.mock.calls[0]![1]!.body!)).toEqual({firmId:nativeId});expect(f.onConnection).toHaveBeenCalledWith(true);
});
it('parses the locked zero-run response without inventing evidence and refuses mixed run fields',async()=>{
 const f=fixture(),view={candidateId:nativeId,candidateRevision:2,status:'not_started',nativeEligibility:{status:'pending',reason:'evidence_pending',channelAuthority:'not_granted'}};
 f.send.mockResolvedValueOnce({status:200,body:view});expect(await f.handler({firmId:nativeId})).toEqual({view,reason:null});
 f.send.mockResolvedValueOnce({status:200,body:{...view,runId:nativeId,observations:[]}});expect(await f.handler({firmId:nativeId})).toEqual({view:null,reason:'unreadable_answer'});
});
it('token-await generation change sends zero reads and no stale connection/auth side effects',async()=>{
 let resolve!:(value:AccessSession)=>void;const f=fixture(()=>new Promise(done=>{resolve=done;}));const pending=f.handler({firmId:nativeId});f.change();resolve({token:'replacement',generation:2});
 expect(await pending).toEqual({view:null,reason:'session_changed'});expect(f.send).not.toHaveBeenCalled();expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
});
it.each(['refusal','success','network'] as const)('drops old owner %s after dispatch without auth/connection side effects',async kind=>{
 const f=fixture();f.send.mockImplementationOnce(async()=>{f.change();if(kind==='network')throw new Error('offline');return kind==='refusal'?{status:401,body:{error:'device_revoked'}}:{status:200,body:nativeView()};});
 expect(await f.handler({firmId:nativeId})).toEqual({view:null,reason:'session_changed'});expect(f.onConnection).not.toHaveBeenCalled();expect(f.onAuthRefusal).not.toHaveBeenCalled();
});
