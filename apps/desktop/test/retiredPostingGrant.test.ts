import {expect,it} from 'vitest';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {createSocialDeliveryPorts} from '../src/main/social/deliveryApi.ts';
import {submitApprovedSocialPost} from '../src/main/social/deliveryLoop.ts';
import type {ApprovedPost,SocialAdapter} from '../src/main/social/adapters.ts';

it('never submits a legacy policy-bound grant or asks an old server to revive removed posting authority',async()=>{
 const id='11111111-1111-4111-8111-111111111111',fingerprint='a'.repeat(64),now=Date.parse('2026-10-18T12:00:00Z');
 const post:ApprovedPost={deliveryId:id,postId:id,revision:1,account:{platform:'linkedin',externalId:'fixture',displayName:'Fixture'},text:'Manually staged fixture',images:[],publishAt:new Date(now+86400_000).toISOString(),zone:'America/New_York',fingerprint};
 const paths:string[]=[];
 const api=createAuthedClient({baseUrl:'https://fixture.invalid',clientVersion:'1.0.51',accessToken:async()=>({token:'fixture',generation:1}),send:async url=>{
  const path=new URL(url).pathname;paths.push(path);
  if(path==='/social/delivery/claim')return {status:200,body:{status:'accepted',replayed:false,result:{claimId:id,approvalId:id,fingerprint,expiresAt:new Date(now+300_000).toISOString()}}};
  if(path==='/social/delivery/begin')return {status:200,body:{status:'accepted',replayed:false,result:{submissionId:id,postingPolicyBound:true}}};
  throw new Error(`Unexpected retired or repeated request ${path}`);
 }});
 let staged=0,submitted=0,inspected=0;
 const adapter:SocialAdapter={
  async inspectAccount(){return post.account;},
  async stage(){staged++;return {ready:true};},
  async submit(){submitted++;return {kind:'scheduled',receiptId:'unused'};},
  async inspect(){inspected++;return {state:'unknown',receiptId:null,permalink:null,observedAt:new Date(now).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false};},
  async cancel(){throw new Error('No cancellation requested');},
 };
 const port=createSocialDeliveryPorts({api,current:()=>true,now:()=>now});
 expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'unknown'});
 expect(staged).toBe(1);expect(submitted).toBe(0);expect(inspected).toBe(0);
 expect(paths).toEqual(['/social/delivery/claim','/social/delivery/begin']);
 expect(await port.dispatchCurrent?.(id)).toBe(false);
 expect(paths).toHaveLength(2);
});
