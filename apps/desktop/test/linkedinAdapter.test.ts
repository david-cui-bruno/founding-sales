import {expect,it,vi} from 'vitest';
import {submitApprovedSocialPost} from '../src/main/social/deliveryLoop.ts';
vi.mock('../src/main/social/adapters/linkedinCancel.ts',()=>({cancelLinkedInReceipt:vi.fn()}));
import {cancelLinkedInReceipt} from '../src/main/social/adapters/linkedinCancel.ts';
vi.mock('../src/main/social/adapters/linkedinStage.ts',()=>({stageLinkedInText:vi.fn(async()=>({ready:true}))}));
vi.mock('../src/main/social/adapters/linkedinReceiptInspection.ts',()=>({inspectLinkedInTextReceipt:vi.fn()}));
import {createLinkedInTextAdapter} from '../src/main/social/adapters/linkedinAdapter.ts';
import {inspectLinkedInTextReceipt} from '../src/main/social/adapters/linkedinReceiptInspection.ts';
import type {SocialAdapterContext} from '../src/main/social/deliveryRunner.ts';
import type {ApprovedPost} from '../src/main/social/adapters.ts';
const context:SocialAdapterContext={snapshot:{account:{id:'id',platform:'linkedin',externalId:'profile',revision:1,adapterVersion:'v1'},text:'Approved',images:[],publishAt:'2026-11-02T15:00:00.000Z',zone:'America/New_York'},fingerprint:'a'.repeat(64),displayName:'Founder'};
const post:ApprovedPost={deliveryId:'d',postId:'p',revision:1,account:{platform:'linkedin',externalId:'profile',displayName:'Founder'},text:context.snapshot.text,images:[],publishAt:context.snapshot.publishAt,zone:context.snapshot.zone,fingerprint:context.fingerprint};
function setup(){const port={current:()=>true,now:()=>Date.parse('2026-10-06T12:00:00Z'),wait:async()=>{},account:vi.fn(async()=>post.account),openComposer:vi.fn(async()=>{}),openScheduledList:vi.fn(async()=>{}),list:vi.fn(),detail:vi.fn(),contents:{getURL:()=> 'https://www.linkedin.com/sharing/compose',insertText:vi.fn(),executeJavaScriptInIsolatedWorld:vi.fn(async()=>({attempted:true}))}};return {port,adapter:createLinkedInTextAdapter(context,port)};}
it('requires staging and exact approval before one final submission attempt',async()=>{const {adapter,port}=setup();expect(await adapter.submit(post)).toMatchObject({kind:'not_submitted'});expect(await adapter.stage(post)).toEqual({ready:true});expect(await adapter.submit({...post,text:'Changed'})).toMatchObject({kind:'not_submitted'});expect(await adapter.submit(post)).toEqual({kind:'unknown'});expect(await adapter.submit(post)).toMatchObject({kind:'not_submitted'});expect(port.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);});
it('recovers from the immutable snapshot without staging or submitting again',async()=>{const {adapter,port}=setup();vi.mocked(inspectLinkedInTextReceipt).mockResolvedValue({state:'scheduled',receiptId:'urn:li:share:123',permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'profile',observedFingerprint:context.fingerprint,complete:true});expect(await adapter.inspect({receiptId:null,fingerprint:context.fingerprint})).toMatchObject({state:'scheduled'});expect(inspectLinkedInTextReceipt).toHaveBeenLastCalledWith(expect.objectContaining({text:'Approved',publishAt:post.publishAt}),null,expect.any(Object));expect(port.openComposer).not.toHaveBeenCalled();expect(port.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();});
it('does not retry a click whose response was lost and refuses wrong fingerprints',async()=>{const {adapter,port}=setup();await adapter.stage(post);port.contents.executeJavaScriptInIsolatedWorld.mockRejectedValue(new Error('lost'));expect(await adapter.submit(post)).toEqual({kind:'unknown'});expect(await adapter.submit(post)).toMatchObject({kind:'not_submitted'});expect(port.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);expect(await adapter.inspect({receiptId:null,fingerprint:'wrong'})).toMatchObject({state:'unknown'});expect(port.openScheduledList).not.toHaveBeenCalled();});

it('recovers a lost final-click response through the delivery loop without another submission',async()=>{
 const {adapter,port}=setup();port.contents.executeJavaScriptInIsolatedWorld.mockRejectedValue(new Error('lost after click'));
 vi.mocked(inspectLinkedInTextReceipt).mockResolvedValue({state:'scheduled',receiptId:'urn:li:share:123',permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'profile',observedFingerprint:context.fingerprint,complete:true});
 const delivery={current:port.current,now:port.now,claim:async()=>({ok:true as const,claimId:'claim',approvalId:'approval',fingerprint:context.fingerprint,expiresAt:'2026-10-06T12:05:00Z'}),begin:vi.fn(async()=>({ok:true as const,submissionId:'submission'})),observe:vi.fn(async()=>true)};
 expect(await submitApprovedSocialPost(post,adapter,delivery)).toEqual({state:'scheduled'});
 expect(delivery.begin.mock.invocationCallOrder[0]).toBeLessThan(port.contents.executeJavaScriptInIsolatedWorld.mock.invocationCallOrder[0]!);expect(port.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);expect(delivery.observe).toHaveBeenCalledWith('submission',expect.objectContaining({receiptId:'urn:li:share:123',complete:true}));
});
it('cancellation reinspects and does not claim cancellation for a row already absent',async()=>{
 const {adapter}=setup();vi.mocked(inspectLinkedInTextReceipt).mockResolvedValue({state:'scheduled',receiptId:'urn:li:share:123',permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'profile',observedFingerprint:context.fingerprint,complete:true});
 vi.mocked(cancelLinkedInReceipt).mockResolvedValue({state:'absent'});expect(await adapter.cancel('urn:li:share:123')).toMatchObject({state:'unknown'});
 vi.mocked(cancelLinkedInReceipt).mockResolvedValue({state:'cancelled'});expect(await adapter.cancel('urn:li:share:123')).toMatchObject({state:'cancelled',complete:true});
});
