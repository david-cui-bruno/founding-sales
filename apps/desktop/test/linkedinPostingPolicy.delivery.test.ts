import {it,expect,vi} from 'vitest';
import {submitApprovedSocialPost,type DeliveryPorts} from '../src/main/social/deliveryLoop.ts';
import type {ApprovedPost,SocialAdapter} from '../src/main/social/adapters.ts';
const post:ApprovedPost={deliveryId:'delivery',postId:'post',revision:1,account:{platform:'linkedin',externalId:'account',displayName:'Founder'},text:'Approved text',images:[],publishAt:'2026-11-01T15:00:00Z',zone:'America/New_York',fingerprint:'hash'};
function setup(){
 const adapter:SocialAdapter={inspectAccount:async()=>post.account,stage:async()=>({ready:true}),submit:vi.fn(async()=>({kind:'unknown' as const})),inspect:async()=>({state:'unknown',receiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:null,observedFingerprint:null,complete:false}),cancel:async()=>{throw new Error('unused');}};
 const port:DeliveryPorts={claim:async()=>({ok:true,claimId:'claim',approvalId:'approval',fingerprint:'hash',expiresAt:'2026-10-13T23:00:00Z'}),begin:async()=>({ok:true,submissionId:'marker',postingPolicyBound:true}),observe:vi.fn(async()=>true),current:()=>true,now:()=>Date.parse('2026-10-13T21:00:00Z')};
 return {adapter,port};
}
it('server-derived bound marker refuses submit when final freshness callback is absent',async()=>{
 const {adapter,port}=setup();expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'unknown'});expect(adapter.submit).not.toHaveBeenCalled();
});
it('false offline and throwing freshness checks never dispatch or replay a bound action',async()=>{
 for(const check of [async()=>false,async()=>{throw new Error('offline');}]){
  const {adapter,port}=setup();port.dispatchCurrent=check;
  expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'unknown'});expect(adapter.submit).not.toHaveBeenCalled();
 }
});
it('current bound work checks after begin and submits only once through the existing adapter',async()=>{
 const {adapter,port}=setup(),check=vi.fn(async()=>true);port.dispatchCurrent=check;
 expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'unknown'});
 expect(check).toHaveBeenCalledWith('marker');expect(adapter.submit).toHaveBeenCalledTimes(1);
 expect(check.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(adapter.submit).mock.invocationCallOrder[0]!);
});
it('unbound manual approval retains its existing behavior without the optional policy callback',async()=>{
 const {adapter,port}=setup();port.begin=async()=>({ok:true,submissionId:'manual-marker'});
 expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'unknown'});expect(adapter.submit).toHaveBeenCalledTimes(1);
});
