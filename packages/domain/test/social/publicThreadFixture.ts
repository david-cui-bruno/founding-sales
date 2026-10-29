import {randomUUID} from 'node:crypto';
import type {SocialPublicThreadRetainInput} from '@fss/contracts';
import {publicThreadSHA256} from '../../social/publicThreadValidation.ts';
export const publicThreadFixtureUrl='https://www.linkedin.com/feed/update/urn:li:activity:1234567890/';
export function publicThreadFixture(capturedAt:string,threadId:string=randomUUID(),sourceExpiresAt:string|null=null):SocialPublicThreadRetainInput{
 const first='Fictional public thread original about a maintenance workflow.',reply='Fictional retained reply with incomplete text coverage.';
 return {threadId,capturedAt,sourceExpiresAt,snapshot:{platform:'linkedin',visibility:'public_web',url:publicThreadFixtureUrl,coverage:'partial',messages:[
  {messageId:'post:1234567890',parent:{kind:'root'},author:{status:'known',displayName:'Fictional Author'},publishedAt:{status:'known',at:capturedAt},
   text:first,textSHA256:publicThreadSHA256(first),textCoverage:'complete',locator:{threadUrl:publicThreadFixtureUrl,messageId:'post:1234567890'}},
  {messageId:'comment:2',parent:{kind:'retained',messageId:'post:1234567890'},author:{status:'unknown'},publishedAt:{status:'unknown'},
   text:reply,textSHA256:publicThreadSHA256(reply),textCoverage:'truncated',locator:{threadUrl:publicThreadFixtureUrl,messageId:'comment:2'}},
 ]}};
}
