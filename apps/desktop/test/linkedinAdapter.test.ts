import {expect,it,vi} from 'vitest';
import {submitApprovedSocialPost} from '../src/main/social/deliveryLoop.ts';
vi.mock('../src/main/social/adapters/linkedinCancel.ts',()=>({cancelLinkedInReceipt:vi.fn()}));
import {cancelLinkedInReceipt} from '../src/main/social/adapters/linkedinCancel.ts';
vi.mock('../src/main/social/adapters/linkedinStage.ts',()=>({stageLinkedInText:vi.fn(async()=>({ready:true}))}));
vi.mock('../src/main/social/adapters/linkedinReceiptInspection.ts',()=>({inspectLinkedInTextReceipt:vi.fn(),inspectLinkedInImageReceipt:vi.fn(),inspectLinkedInSubmittedImage:vi.fn()}));
vi.mock('../src/main/social/adapters/linkedinPostStage.ts',()=>({stageLinkedInPost:vi.fn(async()=>({ready:true}))}));
import {createLinkedInTextAdapter,createLinkedInImageAdapter} from '../src/main/social/adapters/linkedinAdapter.ts';
import {inspectLinkedInTextReceipt,inspectLinkedInImageReceipt,inspectLinkedInSubmittedImage} from '../src/main/social/adapters/linkedinReceiptInspection.ts';
import type {SocialAdapterContext} from '../src/main/social/deliveryRunner.ts';
import type {ApprovedPost} from '../src/main/social/adapters.ts';
const context:SocialAdapterContext={snapshot:{account:{id:'id',platform:'linkedin',externalId:'profile',revision:1,adapterVersion:'v1'},text:'Approved',images:[],publishAt:'2026-11-02T15:00:00.000Z',zone:'America/New_York'},fingerprint:'a'.repeat(64),displayName:'Founder'};
const post:ApprovedPost={deliveryId:'d',postId:'p',revision:1,account:{platform:'linkedin',externalId:'profile',displayName:'Founder'},text:context.snapshot.text,images:[],publishAt:context.snapshot.publishAt,zone:context.snapshot.zone,fingerprint:context.fingerprint};
function setup(){const port={current:()=>true,now:()=>Date.parse('2026-10-06T12:00:00Z'),wait:async()=>{},account:vi.fn(async()=>post.account),waitForSave:vi.fn(async()=>true),openComposer:vi.fn(async()=>{}),openScheduledList:vi.fn(async()=>{}),list:vi.fn(),detail:vi.fn(),contents:{getURL:()=> 'https://www.linkedin.com/sharing/compose',insertText:vi.fn(),executeJavaScriptInIsolatedWorld:vi.fn(async()=>({attempted:true}))}};return {port,adapter:createLinkedInTextAdapter(context,port)};}
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

it('recovers an exact published receipt after its scheduled time without another click',async()=>{
 const h=setup();h.port.now=()=>Date.parse('2026-11-03T12:00:00Z');
 vi.mocked(inspectLinkedInTextReceipt).mockResolvedValue({state:'unknown',receiptId:null,permalink:null,observedAt:new Date(h.port.now()).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false});
 const published=vi.fn(async()=>({ok:true,view:{shareId:'urn:li:share:123',activityId:'urn:li:activity:456',authorExternalId:'profile',text:'Approved',permalink:'https://www.linkedin.com/feed/update/urn:li:activity:456/',publishedAt:null}}));
 const adapter=createLinkedInTextAdapter(context,{...h.port,published});
 expect(await adapter.inspect({receiptId:'urn:li:share:123',fingerprint:context.fingerprint})).toMatchObject({state:'published',receiptId:'urn:li:share:123',complete:true,permalink:'https://www.linkedin.com/feed/update/urn:li:activity:456/'});
 expect(h.port.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
 published.mockResolvedValueOnce({ok:true,view:{shareId:'urn:li:share:999',activityId:'urn:li:activity:456',authorExternalId:'profile',text:'Approved',permalink:'https://www.linkedin.com/feed/update/urn:li:activity:456/',publishedAt:null}});
 expect(await adapter.inspect({receiptId:'urn:li:share:123',fingerprint:context.fingerprint})).toMatchObject({state:'unknown'});
});
it('does not search for a publication without a known receipt or before its scheduled time',async()=>{
 const h=setup(),published=vi.fn();vi.mocked(inspectLinkedInTextReceipt).mockResolvedValue({state:'unknown',receiptId:null,permalink:null,observedAt:new Date(h.port.now()).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false});
 const adapter=createLinkedInTextAdapter(context,{...h.port,published});
 await adapter.inspect({receiptId:'urn:li:share:123',fingerprint:context.fingerprint});
 await adapter.inspect({receiptId:null,fingerprint:context.fingerprint});expect(published).not.toHaveBeenCalled();
});
it.each(['text','author','permalink','session','account'])('keeps publication unknown when %s changes during recovery',async change=>{
 const h=setup();h.port.now=()=>Date.parse('2026-11-03T12:00:00Z');
 vi.mocked(inspectLinkedInTextReceipt).mockResolvedValue({state:'unknown',receiptId:null,permalink:null,observedAt:new Date(h.port.now()).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false});
 let active=true;const published=async()=>{
  if(change==='session')active=false;
  if(change==='account')h.port.account.mockResolvedValue({...post.account,externalId:'other'});
  return {ok:true,view:{shareId:'urn:li:share:123',activityId:'urn:li:activity:456',authorExternalId:change==='author'?'other':'profile',text:change==='text'?'Changed':'Approved',permalink:change==='permalink'?'https://evil.test/':'https://www.linkedin.com/feed/update/urn:li:activity:456/',publishedAt:null}};
 };
 const adapter=createLinkedInTextAdapter(context,{...h.port,current:()=>active,published});
 expect(await adapter.inspect({receiptId:'urn:li:share:123',fingerprint:context.fingerprint})).toMatchObject({state:'unknown',complete:false});
 expect(h.port.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
});

it('keeps inspection from navigating while the attempted save remains unsettled',async()=>{
 const {adapter,port}=setup();port.waitForSave.mockResolvedValue(false);
 await adapter.stage(post);await adapter.submit(post);
 expect(await adapter.inspect({receiptId:null,fingerprint:context.fingerprint})).toMatchObject({state:'unknown'});
 expect(port.openScheduledList).not.toHaveBeenCalled();
 port.waitForSave.mockResolvedValue(true);
 await adapter.inspect({receiptId:null,fingerprint:context.fingerprint});
 expect(port.openScheduledList).toHaveBeenCalledTimes(1);
 expect(port.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
});
it('also waits after a lost click response and never repeats that click',async()=>{
 const {adapter,port}=setup();port.contents.executeJavaScriptInIsolatedWorld.mockRejectedValue(new Error('lost'));
 port.waitForSave.mockResolvedValue(false);await adapter.stage(post);await adapter.submit(post);
 await adapter.inspect({receiptId:null,fingerprint:context.fingerprint});
 expect(port.waitForSave).toHaveBeenCalled();expect(port.openScheduledList).not.toHaveBeenCalled();
 expect(await adapter.submit(post)).toMatchObject({kind:'not_submitted'});
});

it('uses persisted image evidence for recovery but never permits an image submission through the text adapter',async()=>{
 const h=setup(),mediaBinding={receiptId:'urn:li:share:123',fingerprint:context.fingerprint,images:[{sha256:'b'.repeat(64),platformId:'native-image'}]};
 const image={assetId:'id',version:1,sha256:'b'.repeat(64),altText:'Alt',mime:'image/png',width:100,height:100};
 const adapter=createLinkedInTextAdapter({...context,mediaBinding,snapshot:{...context.snapshot,images:[image]}},h.port);
 vi.mocked(inspectLinkedInImageReceipt).mockResolvedValue({state:'scheduled',receiptId:mediaBinding.receiptId,permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'profile',observedFingerprint:context.fingerprint,complete:true,mediaBinding});
 expect(await adapter.inspect({receiptId:mediaBinding.receiptId,fingerprint:context.fingerprint})).toMatchObject({state:'scheduled',mediaBinding});
 expect(inspectLinkedInImageReceipt).toHaveBeenCalledWith(expect.objectContaining({images:[{sha256:image.sha256,altText:image.altText}]}),mediaBinding,expect.any(Object));
 expect(await adapter.inspect({receiptId:'urn:li:share:999',fingerprint:context.fingerprint})).toMatchObject({state:'unknown'});
 expect(await adapter.stage({...post,images:[{...image,localPath:'/unused'}]})).toMatchObject({ready:false});
 expect(h.port.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
});

it('captures original image proof before navigating to its new saved receipt',async()=>{
 const h=setup();h.port.list.mockResolvedValue({ok:true,complete:true,total:0,rows:[]});
 const image={assetId:'id',version:1,sha256:'b'.repeat(64),altText:'Alt',mime:'image/png',width:100,height:100};
 const adapter=createLinkedInImageAdapter({...context,snapshot:{...context.snapshot,images:[image]}},{...h.port,root:'/private'});
 const imagePost={...post,images:[{...image,localPath:'/private/image.png'}]};
 expect(await adapter.stage(imagePost)).toMatchObject({ready:true});
 h.port.contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({attempted:true}).mockResolvedValueOnce({ok:true,view:{sha256:image.sha256,platformId:'native-image'}} as never);
 await adapter.submit(imagePost);
 vi.mocked(inspectLinkedInSubmittedImage).mockResolvedValue({state:'scheduled',receiptId:'urn:li:share:123',permalink:null,observedAt:'2026-10-06T12:00:00Z',accountExternalId:'profile',observedFingerprint:context.fingerprint,complete:true,mediaBinding:{receiptId:'urn:li:share:123',fingerprint:context.fingerprint,images:[{sha256:image.sha256,platformId:'native-image'}]}});
 expect(await adapter.inspect({receiptId:null,fingerprint:context.fingerprint})).toMatchObject({state:'scheduled'});
 expect(inspectLinkedInSubmittedImage).toHaveBeenCalledWith(expect.anything(),{sha256:image.sha256,platformId:'native-image'},[],expect.anything());
 expect(await adapter.submit(imagePost)).toMatchObject({kind:'not_submitted'});
});
it('never infers image identity after a lost submission response or missing native transition',async()=>{
 const h=setup();h.port.list.mockResolvedValue({ok:true,complete:true,total:0,rows:[]});
 const image={assetId:'id',version:1,sha256:'b'.repeat(64),altText:'Alt',mime:'image/png',width:100,height:100};
 const adapter=createLinkedInImageAdapter({...context,snapshot:{...context.snapshot,images:[image]}},{...h.port,root:'/private'}),imagePost={...post,images:[{...image,localPath:'/private/image.png'}]};
 await adapter.stage(imagePost);
 h.port.contents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce({ok:false} as never);
 expect(await adapter.submit(imagePost)).toMatchObject({kind:'unknown'});
 expect(await adapter.inspect({receiptId:null,fingerprint:context.fingerprint})).toMatchObject({state:'unknown'});
 expect(h.port.openScheduledList).toHaveBeenCalledTimes(1);
 expect(await adapter.submit(imagePost)).toMatchObject({kind:'not_submitted'});
});
