import {z} from 'zod';
import {socialInspectionSchema,socialPostRevisionSchema} from '@fss/contracts';
import type {AuthedClient} from '../authedClient.ts';
import type {DeliveryPorts} from './deliveryLoop.ts';
const claimSchema=z.strictObject({claimId:z.string().uuid(),approvalId:z.string().uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),expiresAt:z.string().datetime()});
/** Create once per attempt. Never reuse a begin response as permission for a second click. */
export function createSocialDeliveryPorts(deps:{api:AuthedClient;current():boolean;now():number}):DeliveryPorts{
 let began=false;
 return {
 current:deps.current,now:deps.now,
 async claim(post){
  if(!deps.current())return {ok:false,reason:'session_changed'};
  const result=await deps.api.command('/social/delivery/claim',{postId:post.postId,expectedRevision:post.revision},v=>claimSchema.parse(v));
  if(!deps.current())return {ok:false,reason:'session_changed'};
  return result.ok?{ok:true,...result.value}:{ok:false,reason:result.reason};
 },
 async begin(input){
  if(began)return {ok:false,reason:'inspect_existing_submission'};
  if(!deps.current())return {ok:false,reason:'session_changed'};
  began=true;
  const result=await deps.api.command('/social/delivery/begin',input,v=>z.strictObject({submissionId:z.string().uuid()}).parse(v));
  // The durable marker might already exist; the next queue read must inspect it.
  if(!deps.current()||(!result.ok&&(result.offline||result.reason==='unreadable_answer')))throw new Error('submission_uncertain');
  return result.ok?{ok:true,...result.value}:{ok:false,reason:result.reason};
 },
 async observe(submissionId,observation){
  if(!deps.current())return false;
  const result=await deps.api.command('/social/delivery/observe',{submissionId,observation:socialInspectionSchema.parse(observation)},v=>socialPostRevisionSchema.parse(v));
  return deps.current()&&result.ok;
 },
 };
}
