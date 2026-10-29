import {expect,it} from 'vitest';
import {socialPublicThreadSnapshotSchema,socialPublicThreadListInputSchema,socialPublicThreadReadInputSchema,socialPublicThreadMetadataSchema} from '@fss/contracts';
import {validateRetainedPublicThread,publicThreadSHA256} from '../../social/publicThreadValidation.ts';
import {publicThreadFixture} from './publicThreadFixture.ts';
const capture='2026-10-29T08:00:00.000Z',now='2026-10-29T08:01:00.000Z';
it('retains explicit partial coverage, unknown attribution/time and the earlier source expiry',()=>{
 const input=publicThreadFixture(capture,undefined,'2026-10-30T08:00:00.000Z'),result=validateRetainedPublicThread(input,now);
 expect(result).toMatchObject({ok:true,expiresAt:'2026-10-30T08:00:00.000Z'});
 if(!result.ok)throw Error('Controlled snapshot invalid');expect(result.payloadSHA256).toBe(publicThreadSHA256(JSON.stringify(result.input.snapshot)));
 expect(result.input.snapshot.messages[1]).toMatchObject({author:{status:'unknown'},publishedAt:{status:'unknown'},textCoverage:'truncated'});
 expect(validateRetainedPublicThread(publicThreadFixture(capture),now)).toMatchObject({expiresAt:'2026-11-28T08:00:00.000Z'});
});
it.each([
 'https://linkedin.com/feed/update/urn:li:activity:123/',
 'https://www.linkedin.com/feed/update/urn:li:activity:123/?comment=1',
 'https://www.linkedin.com/feed/update/urn:li:activity:123/#comment',
 'https://user@www.linkedin.com/feed/update/urn:li:activity:123/',
 'https://www.linkedin.com:443/feed/update/urn:li:activity:123/',
 'https://www.linkedin.com/groups/123/',
 'https://www.linkedin.com/messaging/thread/123/',
 'https://foreign.invalid/feed/update/urn:li:activity:123/',
])('refuses noncanonical or unsupported public route %s',url=>{
 const input=publicThreadFixture(capture);input.snapshot.url=url;expect(validateRetainedPublicThread(input,now)).toEqual({ok:false,reason:'invalid_input'});
});
it.each(['duplicate','later parent','wrong locator','unknown author extra','profile inferred','blank','long','oversized payload','wrong text hash','future publication','future capture','old capture','expired source'] as const)('holds invalid retained original: %s',change=>{
 const input=publicThreadFixture(capture),message=input.snapshot.messages[0]!;
 if(change==='duplicate')input.snapshot.messages.push(message);
 if(change==='later parent')message.parent={kind:'retained',messageId:'comment:2'};
 if(change==='wrong locator')message.locator.messageId='other';
 if(change==='unknown author extra')Object.assign(input.snapshot.messages[1]!.author,{displayName:'Inferred'});
 if(change==='profile inferred')Object.assign(message.author,{profileUrl:'https://www.linkedin.com/in/inferred/'});
 if(change==='blank')message.text=' ';
 if(change==='long')message.text='😀'.repeat(1001);
 if(change==='oversized payload')input.snapshot.messages=Array.from({length:50},(_,index)=>({...message,messageId:`post:${index}`,parent:{kind:'root'},locator:{threadUrl:input.snapshot.url,messageId:`post:${index}`},text:'x'.repeat(2000)}));
 if(change==='wrong text hash')message.textSHA256='f'.repeat(64);
 if(change==='future publication')message.publishedAt={status:'known',at:'2026-10-29T08:05:00.001Z'};
 if(change==='future capture')input.capturedAt='2026-10-29T08:01:00.001Z';
 if(change==='old capture')input.capturedAt='2026-09-29T08:00:59.999Z';
 if(change==='expired source')input.sourceExpiresAt='2026-10-29T08:00:30.000Z';
 expect(validateRetainedPublicThread(input,now).ok).toBe(false);
});
it('bounds IDs/messages and rejects invented complete-thread or private scope',()=>{
 const input=publicThreadFixture(capture);
 for(const patch of [{coverage:'complete'},{visibility:'private_group'},{platform:'facebook'}])expect(socialPublicThreadSnapshotSchema.safeParse({...input.snapshot,...patch}).success).toBe(false);
 input.snapshot.messages[0]!.messageId='x'.repeat(129);expect(socialPublicThreadSnapshotSchema.safeParse(input.snapshot).success).toBe(false);
 expect(socialPublicThreadListInputSchema.safeParse({capture:true}).success).toBe(false);
 expect(socialPublicThreadReadInputSchema.safeParse({threadId:input.threadId}).success).toBe(false);
 expect(socialPublicThreadMetadataSchema.safeParse({threadId:input.threadId,revision:2,capturedAt:capture,expiresAt:now,availability:'unavailable',reason:'removed',url:input.snapshot.url}).success).toBe(false);
});
