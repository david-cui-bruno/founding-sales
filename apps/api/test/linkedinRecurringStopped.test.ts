import {it,expect} from 'vitest';
import {recurringFixture,recurringCommand} from './support/linkedinRecurringFixture.ts';

for(const stop of ['adapter_unavailable','cancel_before_begin','matched_cancel_after_begin'] as const){
 it(`public recurring read reports definitive ${stop} without losing admission or financial evidence`,async()=>{
  const h=await recurringFixture();try{
   await h.prepare();await h.run();
   const before=(await h.read()).items[0]!;
   expect(before).toMatchObject({state:'queued',reason:null,approvalKind:'standing_policy',spendCents:1,submissionId:null,receiptId:null});
   const item=(await h.queue()).items[0]!;
   expect(item.action).toBe('submit');
   const action={postId:item.postId,expectedRevision:item.revision};
   let submissionId:string|null=null;
   if(stop==='adapter_unavailable'){
    expect((await h.call('/social/delivery/hold',recurringCommand({...action,reason:'adapter_unavailable'}))).body).toMatchObject({result:{state:'failed',reason:'adapter_unavailable'}});
   }else if(stop==='cancel_before_begin'){
    expect((await h.call('/social/posts/cancel',recurringCommand(action))).body).toMatchObject({result:{state:'cancelled'}});
   }else{
    const claim=await h.call('/social/delivery/claim',recurringCommand(action));
    expect(claim.status).toBe(200);
    const claimed=(claim.body as {result:{claimId:string;approvalId:string;fingerprint:string}}).result;
    const begun=await h.call('/social/delivery/begin',recurringCommand({claimId:claimed.claimId,approvalId:claimed.approvalId,fingerprint:claimed.fingerprint}));
    expect(begun.status).toBe(200);
    submissionId=(begun.body as {result:{submissionId:string}}).result.submissionId;
    expect((await h.call('/social/posts/cancel',recurringCommand(action))).body).toMatchObject({result:{state:'cancellation_pending'}});
    expect((await h.read()).items[0]).toMatchObject({state:'unknown_paused',submissionId});
    expect((await h.call('/social/delivery/observe',recurringCommand({submissionId,observation:{state:'cancelled',receiptId:'controlled-cancelled-receipt',permalink:null,observedAt:new Date().toISOString(),accountExternalId:item.snapshot.account.externalId,observedFingerprint:item.fingerprint,complete:true}}))).body).toMatchObject({result:{state:'cancelled'}});
   }
   expect((await h.queue()).items).toEqual([]);
   const after=(await h.read()).items[0]!;
   expect(after).toMatchObject({...before,state:'skipped',reason:stop==='adapter_unavailable'?'adapter_unavailable':'delivery_cancelled',submissionId,receiptId:stop==='matched_cancel_after_begin'?'controlled-cancelled-receipt':null});
   expect(h.counts).toEqual({generations:1,submissions:0});
   await h.prepare();await h.run();
   expect((await h.read()).items).toEqual([after]);
   expect(h.counts).toEqual({generations:1,submissions:0});
  }finally{await h.f.stop();}
 });
}

it('incomplete cancelled observation remains inspect-only instead of claiming a definitive stop',async()=>{
 const h=await recurringFixture();try{
  await h.prepare();await h.run();
  const attempt=await h.submit({unknown:true});
  const before=(await h.read()).items[0]!;
  expect(before).toMatchObject({state:'unknown_paused',spendCents:1});
  expect((await h.call('/social/delivery/observe',recurringCommand({submissionId:before.submissionId,observation:{state:'cancelled',receiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:attempt.post.account.externalId,observedFingerprint:attempt.post.fingerprint,complete:false}}))).body).toMatchObject({result:{state:'unknown',reason:'inspection_incomplete'}});
  expect((await h.read()).items[0]).toEqual(before);
  expect(h.counts).toEqual({generations:1,submissions:1});
 }finally{await h.f.stop();}
});
