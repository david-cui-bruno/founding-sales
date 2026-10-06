import {expect,it,vi} from 'vitest';
import {operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';
it('drops an asset response if the authenticated identity changes while it is loading',async()=>{
 let generation=0;
 const api={read:vi.fn(async()=>{generation++;return {ok:true,value:{assets:[]}};})};
 const handlers=operationHandlers({api,recordings:{identity:{current:()=>generation}}} as unknown as OperationHostDeps);
 expect(await handlers['social.assets']({} as never)).toEqual({assets:null,reason:'not_found'});
});
it('keeps an ambiguous approval command ID and does not claim acceptance',async()=>{
 const command=vi.fn(async()=>({ok:false,reason:'unreadable_answer'}));const read=vi.fn();
 const handlers=operationHandlers({api:{command,read},recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps);
 const commandId='11111111-1111-4111-8111-111111111111',postId='22222222-2222-4222-8222-222222222222';
 expect(await handlers['social.mutate']({action:'approve',postId,expectedRevision:4,commandId} as never)).toEqual({accepted:false,view:null,reason:'unreadable_answer'});
 expect(command.mock.calls[0]).toEqual(['/social/posts/approve',{postId,expectedRevision:4},expect.any(Function),{commandId}]);
 expect(read).not.toHaveBeenCalled();
});
