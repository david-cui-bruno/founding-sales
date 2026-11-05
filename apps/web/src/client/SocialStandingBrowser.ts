import {z} from 'zod';
import {socialStandingCommandSchema,socialFounderInputViewSchema} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {SocialCommandCustody} from './SocialCommandCustody.ts';
import {socialStandingResponses,socialStandingCommandResultSchema,socialStandingReceiptSchema} from '../shared/socialStandingBrowserContract.ts';
import {socialMediaSignedPreviewSchema} from '../shared/socialMediaBrowserContract.ts';
export const SOCIAL_STANDING_PENDING_KEY='callie.browser.pending-social-standing.v1';
const payloadSchema=z.union([
 socialStandingCommandSchema.options[0].omit({commandId:true,clientVersion:true}),
 socialStandingCommandSchema.options[1].omit({commandId:true,clientVersion:true}),
 socialStandingCommandSchema.options[2].omit({commandId:true,clientVersion:true}),
 socialStandingCommandSchema.options[3].omit({commandId:true,clientVersion:true}),
]);
export function standingBrowserRequest(client:BrowserClient,current:()=>void):(path:string,body:unknown)=>Promise<unknown>{
 const custody=new SocialCommandCustody(client,SOCIAL_STANDING_PENDING_KEY);
 return async(path,body)=>{
  current();
  if(path==='/social/media/preview')return client.request(path,socialMediaSignedPreviewSchema,body,current);
  if(path==='/social/inputs/read')return client.request(path,z.strictObject({input:socialFounderInputViewSchema}),body,current);
  if(path==='/social/standing-plan/reconcile')return custody.exclusive(async()=>{
   current();
   const held=custody.read();if(!held)return {state:'accepted',result:null};
   const result=await client.request('/social/standing-plan/receipt',socialStandingReceiptSchema,{commandId:held.commandId,payloadSHA256:held.payloadSHA256},()=>{current();custody.assert(held);});current();
   if(result.state==='unknown')throw Error('Outcome still unknown');
   custody.complete(held);return result;
  });
  if(path==='/social/standing-plan/command')return custody.exclusive(async()=>{
   current();
   const payload=payloadSchema.parse(body),held=await custody.prepare('plan',payload,current);
   const answer=await client.request(path,socialStandingCommandResultSchema,{...payload,commandId:held.commandId},()=>{current();custody.assert(held);});current();
   custody.complete(held);return answer;
  });
  const schema=socialStandingResponses[path];if(!schema)throw Error('Unsupported standing plan request');
  return client.request(path,schema,body,current);
 };
}
