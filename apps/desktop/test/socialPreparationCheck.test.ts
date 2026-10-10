import type {SocialDiagnosticReporter} from '../src/shared/socialDiagnostics.ts';
import {inspectLinkedInPreparation,type PreparationCheck} from '../src/main/social/adapters/linkedinPreparation.ts';
import {expect,it,vi} from 'vitest';
import {createSocialDeliveryRunner} from '../src/main/social/deliveryRunner.ts';
import type {AuthedClient} from '../src/main/authedClient.ts';
import {operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';
const id='11111111-1111-4111-8111-111111111111';
const account={id,platform:'linkedin',externalId:'profile',displayName:'Founder',accountKind:'profile',state:'connected',adapterVersion:'v1',verifiedAt:'2026-10-01T00:00:00Z'};
function fixture(){const command=vi.fn();const read=vi.fn(async(_path:string,parse:(raw:unknown)=>unknown)=>({ok:true,value:parse({accounts:[account],posts:[]})}));const check=vi.fn(async(_scope:unknown,_expected:unknown,report:SocialDiagnosticReporter)=>{report('composer','refused','private DOM secret');return {ready:false,reason:'private DOM secret'} as PreparationCheck;});const runner=createSocialDeliveryRunner({api:{read,command} as unknown as AuthedClient,root:'/unused',identity:async()=>({workspaceId:id,userId:id}),now:()=>0,adapters:{linkedin:{version:'v1',open:async()=>{},check}}});return {read,command,check,runner};}
it('scopes explicit checks through authenticated social reads, sanitizes metadata and never calls a command',async()=>{const h=fixture();const handlers=operationHandlers({socialDelivery:h.runner} as unknown as OperationHostDeps);expect(await handlers['social.checkPreparation']({accountId:id} as never)).toEqual({ready:false,reason:'unknown',events:[{stage:'composer',outcome:'refused',reason:'unknown',at:'1970-01-01T00:00:00.000Z'}]});expect(h.command).not.toHaveBeenCalled();expect(h.read).toHaveBeenCalledWith('/social',expect.any(Function),{});expect(h.check).toHaveBeenCalledWith({workspaceId:id,userId:id,accountId:id,platform:'linkedin'},{platform:'linkedin',externalId:'profile',displayName:'Founder'},expect.any(Function));});
it('refuses unknown accounts and drops a late check after sign-out',async()=>{const h=fixture();expect(await h.runner.checkPreparation('22222222-2222-4222-8222-222222222222')).toMatchObject({ready:false});expect(h.check).not.toHaveBeenCalled();h.check.mockImplementation(async()=>{h.runner.resetStatus();return {ready:false,reason:'private old owner'};});expect(await h.runner.checkPreparation(id)).toEqual({ready:false,reason:'session_changed',events:[]});expect(h.runner.status()).toEqual({queue:'unread',lastReadAt:null});});
it('bounds one browser check metadata to 32 events',async()=>{const h=fixture();h.check.mockImplementation(async(_scope,_expected,report)=>{for(let i=0;i<100;i++)report('composer','refused','layout_changed');return {ready:false,reason:'layout_changed'};});expect((await h.runner.checkPreparation(id)).events).toHaveLength(32);});
it('refuses a ready browser result if the account is disconnected during its check',async()=>{const h=fixture();h.check.mockImplementation(async()=>{h.read.mockImplementation(async(_path,parse)=>({ok:true,value:parse({accounts:[{...account,state:'disconnected'}],posts:[]})}));return {ready:true} as never;});expect(await h.runner.checkPreparation(id)).toMatchObject({ready:false,reason:'session_changed',events:[]});});
it('drops diagnostics when an old owner check throws after sign-out',async()=>{const h=fixture();h.check.mockImplementation(async(_scope,_expected,report)=>{report('composer','refused','layout_changed');h.runner.resetStatus();throw new Error('old owner');});expect(await h.runner.checkPreparation(id)).toEqual({ready:false,reason:'session_changed',events:[]});});

it('waits for unavailable identity through the authenticated preparation operation without any command',async()=>{
 const h=fixture();const expected={platform:'linkedin' as const,externalId:'profile',displayName:'Founder'};
 const accountRead=vi.fn<()=>Promise<typeof expected|null>>().mockResolvedValueOnce(null).mockResolvedValue(expected);
 const openComposer=vi.fn(async()=>{});const wait=vi.fn(async()=>{});
 h.check.mockImplementation(async(_scope,_expected,report)=>inspectLinkedInPreparation(expected,{current:()=>true,account:accountRead,openComposer,wait,contents:{executeJavaScriptInIsolatedWorld:async()=>({ok:true,view:{kind:'composer',postingName:'Founder',text:''}})},diagnostic:report}));
 const handlers=operationHandlers({socialDelivery:h.runner} as unknown as OperationHostDeps);
 expect(await handlers['social.checkPreparation']({accountId:id} as never)).toMatchObject({ready:true,reason:null});
 expect(wait).toHaveBeenCalledTimes(1);expect(openComposer).toHaveBeenCalledTimes(1);expect(h.command).not.toHaveBeenCalled();
});
it.each(['identity_unavailable','identity_sidebar_ambiguous','identity_profile_unavailable'] as const)('bounds %s without exposing page evidence or opening a composer',async(reason)=>{
 const h=fixture();const openComposer=vi.fn(async()=>{});const probeAccount=vi.fn(async()=>({reason}));const wait=vi.fn(async()=>{});
 h.check.mockImplementation(async(_scope,_expected,report)=>inspectLinkedInPreparation({platform:'linkedin',externalId:'profile',displayName:'Founder'},{current:()=>true,account:async()=>null,probeAccount,openComposer,wait,contents:{executeJavaScriptInIsolatedWorld:async()=>{throw new Error('must not read composer');}},diagnostic:report}));
 const result=await operationHandlers({socialDelivery:h.runner} as unknown as OperationHostDeps)['social.checkPreparation']({accountId:id} as never);
 expect(result).toMatchObject({ready:false,reason});expect(probeAccount).toHaveBeenCalledTimes(12);expect(wait).toHaveBeenCalledTimes(11);expect(openComposer).not.toHaveBeenCalled();expect(h.command).not.toHaveBeenCalled();
});
it('never waits through a verified different account and erases results when the owner changes during an unavailable probe',async()=>{
 const h=fixture();const openComposer=vi.fn(async()=>{});const wait=vi.fn(async()=>{});
 const run=async(accountRead:()=>Promise<{platform:'linkedin';externalId:string;displayName:string}|null>)=>{
 h.check.mockImplementation(async(_scope,_expected,report)=>inspectLinkedInPreparation({platform:'linkedin',externalId:'profile',displayName:'Founder'},{current:()=>true,account:accountRead,openComposer,wait,contents:{executeJavaScriptInIsolatedWorld:async()=>null},diagnostic:report}));
 return operationHandlers({socialDelivery:h.runner} as unknown as OperationHostDeps)['social.checkPreparation']({accountId:id} as never);
 };
 expect(await run(async()=>({platform:'linkedin',externalId:'other',displayName:'Founder'}))).toMatchObject({ready:false,reason:'account_identity_changed'});expect(wait).not.toHaveBeenCalled();expect(openComposer).not.toHaveBeenCalled();
 expect(await run(async()=>{h.runner.resetStatus();return null;})).toEqual({ready:false,reason:'session_changed',events:[]});expect(h.command).not.toHaveBeenCalled();
});
