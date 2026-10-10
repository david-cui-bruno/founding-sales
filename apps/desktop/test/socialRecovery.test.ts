import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import type {AuthedClient} from '../src/main/authedClient.ts';
import type {SocialDeliveryQueue} from '@fss/contracts';
import {createSocialDeliveryRunner} from '../src/main/social/deliveryRunner.ts';
const id='11111111-1111-4111-8111-111111111111';
const item:SocialDeliveryQueue['items'][number]={deliveryId:id,postId:id,revision:1,action:'submit',submissionId:null,receiptId:null,fingerprint:'a'.repeat(64),snapshot:{account:{id,platform:'linkedin',externalId:'profile',revision:1,adapterVersion:'v1'},text:'Approved',images:[],publishAt:'2099-11-02T15:00:00.000Z',zone:'America/New_York'}};
function fixture(){const holds:unknown[]=[];const api={read:async()=>({ok:false,reason:'offline',offline:true}),command:async(path:string,input:unknown)=>{if(path==='/social/delivery/hold')holds.push(input);return {ok:false,reason:'offline',offline:true};}} as unknown as AuthedClient;return {holds,runner:createSocialDeliveryRunner({api,root:'/unused',identity:async()=>({workspaceId:id,userId:id}),now:()=>Date.parse('2026-10-09T12:00:00Z'),adapters:{}})};}
it('reports unsupported adapter recovery for an unsubmitted approval, never for a retained marker',async()=>{
 const h=fixture();await h.runner.run(item,()=>true);
 expect(h.holds).toEqual([{postId:id,expectedRevision:1,reason:'adapter_unavailable'}]);
 await h.runner.run({...item,action:'inspect',submissionId:id},()=>true);
 expect(h.holds).toHaveLength(1);
});
it('persists a missed schedule without submitting or replaying on repeated reads',async()=>{
 const holds:unknown[]=[],external:unknown[]=[];
 const api={read:async(_path:string,parse:(v:unknown)=>unknown)=>({ok:true,value:parse({accounts:[{id,platform:'linkedin',externalId:'profile',displayName:'Founder',accountKind:'profile',state:'connected',adapterVersion:'v1',verifiedAt:'2026-10-01T00:00:00Z'}],posts:[]})}),command:async(path:string,input:unknown)=>{if(path==='/social/delivery/hold')holds.push(input);return {ok:false,reason:'delivery_not_pending'};}} as unknown as AuthedClient;
 const adapter={inspectAccount:async()=>({platform:'linkedin' as const,externalId:'profile',displayName:'Founder'}),stage:async()=>({ready:true}),submit:async()=>{external.push('submit');return {kind:'unknown' as const};},inspect:async()=>{throw new Error('unneeded');},cancel:async()=>{throw new Error('unneeded');}};
 const root=await mkdtemp(join(tmpdir(),'social-recovery-'));
 const runner=createSocialDeliveryRunner({api,root,identity:async()=>({workspaceId:id,userId:id}),now:()=>Date.parse('2099-11-03T00:00:00Z'),adapters:{linkedin:{version:'v1',open:async(_scope,run)=>run(adapter,()=>true)}}});
 try{await runner.run(item,()=>true);await runner.run(item,()=>true);}finally{await rm(root,{recursive:true,force:true});}
 expect(holds).toEqual([{postId:id,expectedRevision:1,reason:'schedule_missed'},{postId:id,expectedRevision:1,reason:'schedule_missed'}]);
 expect(external).toEqual([]);
});
it('reports an unreadable queue without claiming that remote deliveries were held',async()=>{
 const h=fixture();await expect(h.runner.read()).rejects.toThrow('queue_unavailable');
 expect(h.runner.status()).toEqual({queue:'unavailable',lastReadAt:null});
 expect(h.holds).toEqual([]);
});
it('clears the previous session delivery status explicitly before another owner uses the runner',async()=>{
 const h=fixture();await expect(h.runner.read()).rejects.toThrow('queue_unavailable');
 h.runner.resetStatus();expect(h.runner.status()).toEqual({queue:'unread',lastReadAt:null});
});
it('does not mark a new session available when the previous session read finishes late',async()=>{
 let finish:(value:{ok:true;value:SocialDeliveryQueue})=>void=()=>{};
 const api={read:()=>new Promise<{ok:true;value:SocialDeliveryQueue}>(resolve=>{finish=resolve;})} as unknown as AuthedClient;
 const runner=createSocialDeliveryRunner({api,root:'/unused',identity:async()=>null,now:()=>0,adapters:{}});
 const previous=runner.read();runner.resetStatus();finish({ok:true,value:{items:[]}});await previous;
 expect(runner.status()).toEqual({queue:'unread',lastReadAt:null});
});
