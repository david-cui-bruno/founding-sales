import {it,expect,vi} from 'vitest';
import {submitApprovedSocialPost} from '../src/main/social/deliveryLoop.ts';
import type {ApprovedPost,SocialAdapter} from '../src/main/social/adapters.ts';
const post:ApprovedPost={deliveryId:'delivery',postId:'post',revision:1,account:{platform:'linkedin',externalId:'account',displayName:'Founder'},text:'Approved text',images:[],publishAt:'2026-11-01T15:00:00Z',zone:'America/New_York',fingerprint:'hash'};
function setup(){const adapter:SocialAdapter={inspectAccount:vi.fn(async()=>post.account),stage:vi.fn(async()=>({ready:true})),submit:vi.fn(async()=>({kind:'scheduled' as const,receiptId:'native'})),inspect:vi.fn(async()=>({state:'scheduled' as const,receiptId:'native',permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'account',observedFingerprint:'hash',complete:true})),cancel:vi.fn(async()=>{throw new Error('unused');})};const port={claim:vi.fn(async()=>({ok:true as const,claimId:'claim',approvalId:'approval',fingerprint:'hash',expiresAt:'2026-10-06T12:05:00Z'})),begin:vi.fn(async()=>({ok:true as const,submissionId:'submission'})),observe:vi.fn(async()=>true),current:()=>true,now:()=>Date.parse('2026-10-06T12:00:00Z')};return {adapter,port};}
it('stages exact content, commits a submission marker, and independently verifies the native receipt',async()=>{
 const {adapter,port}=setup();expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'scheduled'});
 expect(port.begin.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(adapter.submit).mock.invocationCallOrder[0]!);expect(adapter.inspect).toHaveBeenCalledWith({receiptId:'native',fingerprint:'hash'});expect(port.observe).toHaveBeenCalledWith('submission',expect.objectContaining({state:'scheduled',complete:true}));
});
it('does not submit on wrong account, stale fingerprint, or an expired scheduled time',async()=>{
 for(const reason of ['account','fingerprint','time']){const {adapter,port}=setup();if(reason==='account')vi.mocked(adapter.inspectAccount).mockResolvedValue({...post.account,externalId:'other'});if(reason==='fingerprint')port.claim.mockResolvedValue({...await port.claim(),fingerprint:'other'});if(reason==='time')port.now=()=>Date.parse(post.publishAt)+1;
 await submitApprovedSocialPost(post,adapter,port);expect(adapter.submit).not.toHaveBeenCalled();expect(port.begin).not.toHaveBeenCalled();}
});
it('does not click if cancellation invalidates begin, or sign-out happens during staging',async()=>{
 const {adapter,port}=setup();port.begin.mockResolvedValue({ok:false,reason:'claim_invalid'} as never);await submitApprovedSocialPost(post,adapter,port);expect(adapter.submit).not.toHaveBeenCalled();
 const b=setup();let current=true;b.port.current=()=>current;vi.mocked(b.adapter.stage).mockImplementation(async()=>{current=false;return {ready:true};});await submitApprovedSocialPost(post,b.adapter,b.port);expect(b.port.begin).not.toHaveBeenCalled();
});
it('rechecks account after staging before committing or clicking',async()=>{
 const {adapter,port}=setup();vi.mocked(adapter.inspectAccount).mockResolvedValueOnce(post.account).mockResolvedValue({...post.account,externalId:'switched'});await submitApprovedSocialPost(post,adapter,port);expect(port.begin).not.toHaveBeenCalled();expect(adapter.submit).not.toHaveBeenCalled();
});
it('never retries a click when submission or readback is uncertain',async()=>{
 const {adapter,port}=setup();vi.mocked(adapter.submit).mockRejectedValue(new Error('lost receipt'));vi.mocked(adapter.inspect).mockRejectedValue(new Error('offline'));
 expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'unknown'});expect(adapter.submit).toHaveBeenCalledTimes(1);expect(port.observe).toHaveBeenCalledWith('submission',expect.objectContaining({state:'unknown',complete:false}));
});
it('does not trust a receipt without complete matching account/content evidence',async()=>{
 const {adapter,port}=setup();vi.mocked(adapter.inspect).mockResolvedValue({state:'scheduled' as const,receiptId:'native',permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'other',observedFingerprint:'hash',complete:true});expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'unknown'});
});
it('holds after an ambiguous marker response and never clicks',async()=>{
 const {adapter,port}=setup();port.begin.mockRejectedValue(new Error('response lost'));expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'unknown'});expect(adapter.submit).not.toHaveBeenCalled();
});
it('recovery inspects without ever resubmitting and refuses to cancel a mismatched post',async()=>{
 const {reconcileSocialPost}=await import('../src/main/social/deliveryLoop.ts');const {adapter,port}=setup();
 vi.mocked(adapter.inspect).mockResolvedValue({state:'scheduled' as const,receiptId:'native',permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'other',observedFingerprint:'hash',complete:true});
 expect(await reconcileSocialPost(post,{submissionId:'submission',receiptId:'native',cancel:true},adapter,port)).toEqual({state:'unknown'});expect(adapter.cancel).not.toHaveBeenCalled();expect(adapter.submit).not.toHaveBeenCalled();
});
it('cancellation requires matching readback and records only the verified result',async()=>{
 const {reconcileSocialPost}=await import('../src/main/social/deliveryLoop.ts');const {adapter,port}=setup();vi.mocked(adapter.cancel).mockResolvedValue({state:'cancelled',receiptId:'native',permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'account',observedFingerprint:'hash',complete:true});
 expect(await reconcileSocialPost(post,{submissionId:'submission',receiptId:'native',cancel:true},adapter,port)).toEqual({state:'cancelled'});expect(adapter.cancel).toHaveBeenCalledWith('native');expect(port.observe).toHaveBeenCalledWith('submission',expect.objectContaining({state:'cancelled'}));expect(adapter.submit).not.toHaveBeenCalled();
});
it('a missing first page is not proof of absence, and a failed cancellation stays unknown',async()=>{
 const {reconcileSocialPost}=await import('../src/main/social/deliveryLoop.ts');const {adapter,port}=setup();vi.mocked(adapter.inspect).mockResolvedValueOnce({state:'absent',receiptId:null,permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'account',observedFingerprint:'hash',complete:false});
 expect(await reconcileSocialPost(post,{submissionId:'submission',receiptId:'native',cancel:true},adapter,port)).toEqual({state:'unknown'});expect(adapter.cancel).not.toHaveBeenCalled();
 vi.mocked(adapter.cancel).mockRejectedValue(new Error('response lost'));expect(await reconcileSocialPost(post,{submissionId:'submission',receiptId:'native',cancel:true},adapter,port)).toEqual({state:'unknown'});expect(adapter.cancel).toHaveBeenCalledTimes(1);
});
it('rejects a different native receipt even when content and account happen to match',async()=>{
 const {adapter,port}=setup();vi.mocked(adapter.inspect).mockResolvedValue({state:'scheduled',receiptId:'different',permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'account',observedFingerprint:'hash',complete:true});
 expect(await submitApprovedSocialPost(post,adapter,port)).toEqual({state:'unknown'});expect(port.observe).toHaveBeenCalledWith('submission',expect.objectContaining({state:'unknown',complete:false}));
});
