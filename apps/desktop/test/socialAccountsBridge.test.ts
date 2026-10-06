import {expect,it,vi} from 'vitest';
import {createSocialAccountsBridge} from '../src/main/social/accountsBridge.ts';
import type {AuthedClient} from '../src/main/authedClient.ts';
const id='11111111-1111-4111-8111-111111111111',commandId='22222222-2222-4222-8222-222222222222';
function harness(){let generation=0;const open=vi.fn(async()=>({platform:'linkedin' as const,accountKind:'profile' as const,externalAccountId:'https://www.linkedin.com/in/example/',displayName:'Example'}));const clear=vi.fn(async()=>{});const read=vi.fn(async()=>({ok:true,value:{accounts:[],posts:[]}}));const command=vi.fn(async(..._args:unknown[])=>({ok:true,value:{accountId:id,state:'unsupported'}}));const bridge=createSocialAccountsBridge({api:{read,command} as unknown as AuthedClient,identity:async()=>({workspaceId:'w',userId:'u'}),generation:()=>generation,open,clear});return {bridge,open,clear,read,command,change:()=>{generation++;}};}
it('saves only the identity observed by the isolated browser and retries the same payload',async()=>{
 const h=harness();h.command.mockResolvedValueOnce({ok:false,reason:'offline'} as never);
 expect(await h.bridge.connect({accountId:id,commandId})).toEqual({accepted:false,reason:'offline'});
 expect(await h.bridge.connect({accountId:id,commandId})).toEqual({accepted:true,reason:null});
 expect(h.open).toHaveBeenCalledTimes(1);expect(h.command.mock.calls.map(c=>[c[0],c[1],c[3]])[1]).toEqual(h.command.mock.calls.map(c=>[c[0],c[1],c[3]])[0]);
 expect(h.command.mock.calls[0]).toEqual(['/social/accounts/connect',{accountId:id,platform:'linkedin',accountKind:'profile',externalId:'https://www.linkedin.com/in/example/',displayName:'Example'},expect.any(Function),{commandId}]);
});
it('does not save a reconnect to a different profile or a signed-out observation',async()=>{
 const h=harness();h.read.mockResolvedValue({ok:true,value:{accounts:[{id,platform:'linkedin',externalId:'https://www.linkedin.com/in/other/'}],posts:[]}} as never);
 expect(await h.bridge.connect({accountId:id,commandId})).toEqual({accepted:false,reason:'account_identity_changed'});expect(h.command).not.toHaveBeenCalled();
 const q=harness();q.open.mockImplementation(async()=>{q.change();return {platform:'linkedin',accountKind:'profile',externalAccountId:'https://www.linkedin.com/in/example/',displayName:'Example'};});
 expect(await q.bridge.connect({accountId:id,commandId})).toEqual({accepted:false,reason:'session_changed'});expect(q.command).not.toHaveBeenCalled();
});
it('disables the server account before clearing its isolated login',async()=>{
 const h=harness();h.read.mockResolvedValue({ok:true,value:{accounts:[{id,platform:'linkedin'}],posts:[]}} as never);
 h.command.mockResolvedValueOnce({ok:false,reason:'offline'} as never);
 expect(await h.bridge.disconnect({accountId:id,commandId})).toEqual({accepted:false,reason:'offline'});expect(h.clear).not.toHaveBeenCalled();
 expect(await h.bridge.disconnect({accountId:id,commandId})).toEqual({accepted:true,reason:null});expect(h.clear).toHaveBeenCalledWith({workspaceId:'w',userId:'u',accountId:id,platform:'linkedin'});
});
