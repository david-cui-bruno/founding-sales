import {expect,it,vi} from 'vitest';
vi.mock('../src/main/social/queuedPost.ts',()=>({withQueuedSocialPost:vi.fn()}));
vi.mock('../src/main/social/deliveryLoop.ts',()=>({submitApprovedSocialPost:vi.fn(),reconcileSocialPost:vi.fn()}));
import {createSocialDeliveryRunner} from '../src/main/social/deliveryRunner.ts';
import {reconcileSocialPost} from '../src/main/social/deliveryLoop.ts';
import {withQueuedSocialPost} from '../src/main/social/queuedPost.ts';
import type {AuthedClient} from '../src/main/authedClient.ts';import type {SocialAdapter} from '../src/main/social/adapters.ts';import type {SocialDeliveryQueue} from '@fss/contracts';
const id='11111111-1111-4111-8111-111111111111';
const item:SocialDeliveryQueue['items'][number]={deliveryId:id,postId:id,revision:1,action:'cancel',submissionId:id,receiptId:'native',fingerprint:'a'.repeat(64),snapshot:{account:{id,platform:'linkedin',externalId:'profile',revision:1,adapterVersion:'v1'},text:'Approved',images:[],publishAt:'2026-11-02T15:00:00.000Z',zone:'America/New_York'}};
function setup(){let current=true;const adapter={} as SocialAdapter;const read=vi.fn(async(_path:string,parse:(v:unknown)=>unknown)=>({ok:true,value:parse({accounts:[{id,platform:'linkedin',externalId:'profile',displayName:'Founder',accountKind:'profile',state:'reconnect',adapterVersion:'v1',verifiedAt:'2026-10-06T00:00:00.000Z'}],posts:[]})}));const open=vi.fn(async(_scope:unknown,run:(a:SocialAdapter,now:()=>boolean)=>Promise<void>)=>run(adapter,()=>current));const deps={api:{read,command:vi.fn()} as unknown as AuthedClient,root:'/unused',identity:async()=>({workspaceId:'workspace',userId:'owner'}),now:()=>0,adapters:{linkedin:{version:'v1',open}}};return {deps,read,open,adapter,current:()=>current,stop:()=>{current=false;}};}
it('routes cancellation through account-scoped recovery without downloading old media',async()=>{const h=setup();vi.mocked(withQueuedSocialPost).mockClear();await createSocialDeliveryRunner(h.deps).run(item,h.current);expect(h.open).toHaveBeenCalledWith({workspaceId:'workspace',userId:'owner',accountId:id,platform:'linkedin'},expect.any(Function));expect(reconcileSocialPost).toHaveBeenCalledWith({account:{platform:'linkedin',externalId:'profile',displayName:'Founder'},fingerprint:item.fingerprint},{submissionId:id,receiptId:'native',cancel:true},h.adapter,expect.any(Object));expect(withQueuedSocialPost).not.toHaveBeenCalled();expect(h.read).toHaveBeenCalledTimes(1);});
it('does not open unsupported adapter versions or an expired session',async()=>{const h=setup();await createSocialDeliveryRunner(h.deps).run({...item,snapshot:{...item.snapshot,account:{...item.snapshot.account,adapterVersion:'old'}}},h.current);expect(h.open).not.toHaveBeenCalled();h.stop();await createSocialDeliveryRunner(h.deps).run(item,h.current);expect(h.read).not.toHaveBeenCalled();});
it('never resubmits a queue item with an existing marker and stops if the browser session changes',async()=>{
 const h=setup();vi.mocked(withQueuedSocialPost).mockClear();
 await createSocialDeliveryRunner(h.deps).run({...item,action:'submit'},h.current);
 expect(withQueuedSocialPost).not.toHaveBeenCalled();expect(h.open).not.toHaveBeenCalled();
 vi.mocked(reconcileSocialPost).mockClear();h.open.mockImplementation(async(_scope,run)=>run(h.adapter,()=>false));
 await createSocialDeliveryRunner(h.deps).run(item,h.current);expect(reconcileSocialPost).not.toHaveBeenCalled();
});
it('does not run after identity resolution changes the active session',async()=>{
 const h=setup();h.deps.identity=async()=>{h.stop();return {workspaceId:'other',userId:'other'};};
 await createSocialDeliveryRunner(h.deps).run(item,h.current);expect(h.read).not.toHaveBeenCalled();expect(h.open).not.toHaveBeenCalled();
});
