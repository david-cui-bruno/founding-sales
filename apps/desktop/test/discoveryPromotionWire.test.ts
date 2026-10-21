import {expect,it,vi} from 'vitest';
import {createAuthedClient,type AccessSession} from '../src/main/authedClient.ts';
import type {HttpSend} from '../src/main/apiClient.ts';
import {sourcingDiscoveryPromotionHandlers} from '../src/main/sourcingDiscoveryPromotionHandlers.ts';
import {OPERATIONS} from '../src/shared/operations.ts';
const id='11111111-1111-4111-8111-111111111111';
const input={commandId:id,firm:{name:'Synthetic research draft',website:'https://example.test/'}};
const result={firmId:id,contactId:null,routeIds:[]};
function fixture(accessToken:()=>Promise<AccessSession|null>=async()=>({token:'local-test',generation:1})){
 let generation=1;
 const send=vi.fn<HttpSend>(async()=>({status:200,body:{status:'accepted',replayed:false,result}}));
 const api=createAuthedClient({baseUrl:'https://example.test',clientVersion:'test',accessToken,send});
 return {send,handlers:sourcingDiscoveryPromotionHandlers({api,generation:()=>generation}),change:()=>{generation++;}};
}
it('dispatches the existing ordinary add Firm wire with stable command id and no contact or inferred zone',async()=>{
 const f=fixture();expect(await f.handlers['sourcing.discoveryCreateResearchFirm'](input)).toEqual({result,reason:null});
 expect(await f.handlers['sourcing.discoveryCreateResearchFirm'](input)).toEqual({result,reason:null});
 expect(f.send).toHaveBeenCalledTimes(2);
 for(const call of f.send.mock.calls){expect(call[0]).toBe('https://example.test/crm/firms/add');expect(JSON.parse(call[1]!.body!)).toEqual({...input,clientVersion:'test'});}
});
it('refuses extra contact, inferred zone or absent website at the normal registry boundary',()=>{
 const schema=OPERATIONS['sourcing.discoveryCreateResearchFirm'].input;
 expect(schema.safeParse(input).success).toBe(true);
 for(const fields of [{contact:{fullName:'Not authorized'}},{timeZone:'America/Chicago'},{website:null},{website:'example.test'}])expect(schema.safeParse({...input,firm:{...input.firm,...fields}}).success).toBe(false);
});
it('does not dispatch an old-owner command after awaited token resolution',async()=>{
 let resolve!:(value:AccessSession)=>void;
 const f=fixture(()=>new Promise(done=>{resolve=done;}));
 const pending=f.handlers['sourcing.discoveryCreateResearchFirm'](input);f.change();resolve({token:'replacement',generation:2});
 expect(await pending).toEqual({result:null,reason:'session_changed'});expect(f.send).not.toHaveBeenCalled();
});
it('hides committed old-owner result after dispatch and retains the supplied retry identity',async()=>{
 const f=fixture();f.send.mockImplementationOnce(async()=>{f.change();return {status:200,body:{status:'accepted',replayed:false,result}};});
 expect(await f.handlers['sourcing.discoveryCreateResearchFirm'](input)).toEqual({result:null,reason:'session_changed'});
 expect(f.send).toHaveBeenCalledTimes(1);expect(JSON.parse(f.send.mock.calls[0]![1]!.body!).commandId).toBe(id);
});
it('retries an unknown wire result with exactly the supplied command id',async()=>{
 const f=fixture();f.send.mockRejectedValueOnce(new Error('unknown committed result'));
 expect(await f.handlers['sourcing.discoveryCreateResearchFirm'](input)).toEqual({result:null,reason:'offline'});
 expect(await f.handlers['sourcing.discoveryCreateResearchFirm'](input)).toEqual({result,reason:null});
 expect(f.send.mock.calls.map(call=>JSON.parse(call[1]!.body!).commandId)).toEqual([id,id]);
});
