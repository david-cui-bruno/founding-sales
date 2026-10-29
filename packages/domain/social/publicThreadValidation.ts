import {createHash} from 'node:crypto';
import {socialPublicThreadRetainInputSchema,type SocialPublicThreadRetainInput} from '@fss/contracts';
export const publicThreadSHA256=(text:string):string=>createHash('sha256').update(text).digest('hex');
const horizon=30*86400000;
/** Validates retained bytes and declared observation time, never fetches a URL. */
export function validateRetainedPublicThread(raw:SocialPublicThreadRetainInput,now:string):
 {ok:true;input:SocialPublicThreadRetainInput;expiresAt:string;payloadSHA256:string}|{ok:false;reason:'invalid_input'|'invalid_capture_time'|'expired'|'invalid_source_hash'}{
 const parsed=socialPublicThreadRetainInputSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const input=parsed.data,capture=Date.parse(input.capturedAt),clock=Date.parse(now);
 if(!Number.isFinite(clock)||capture>clock||capture<clock-horizon)return {ok:false,reason:'invalid_capture_time'};
 const sourceEnd=input.sourceExpiresAt===null?Infinity:Date.parse(input.sourceExpiresAt);
 if(sourceEnd<=capture)return {ok:false,reason:'invalid_input'};
 const end=Math.min(capture+horizon,sourceEnd);if(end<=clock)return {ok:false,reason:'expired'};
 for(const message of input.snapshot.messages){
  if(message.publishedAt.status==='known'&&Date.parse(message.publishedAt.at)>capture+300000)return {ok:false,reason:'invalid_capture_time'};
  if(publicThreadSHA256(message.text)!==message.textSHA256)return {ok:false,reason:'invalid_source_hash'};
 }
 return {ok:true,input,expiresAt:new Date(end).toISOString(),payloadSHA256:publicThreadSHA256(JSON.stringify(input.snapshot))};
}
