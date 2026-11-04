import {z} from 'zod';
import {uuid,registerSocialAssetSchema,socialMediaApproveInputSchema} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import type {SocialMediaBrowserPort} from './BrowserSocialApprovedMedia.tsx';
import {SocialCommandCustody} from './SocialCommandCustody.ts';
import {socialMediaListSchema,socialMediaSignedPreviewSchema,socialMediaResponses,socialMediaReceiptSchema} from '../shared/socialMediaBrowserContract.ts';
import {socialCommandResult} from '../shared/socialBrowserContract.ts';
export const SOCIAL_MEDIA_PENDING_KEY='callie.browser.pending-social-media.v1';
const registeredSchema=socialCommandResult(z.strictObject({assetId:uuid,uploadId:uuid}));
export function socialMediaBrowser(client:BrowserClient,current:()=>void):SocialMediaBrowserPort{
 const custody=new SocialCommandCustody(client,SOCIAL_MEDIA_PENDING_KEY);
 const command=async(kind:string,path:string,payload:object):Promise<unknown>=>custody.exclusive(async()=>{
  current();
  const epoch=client.epoch,held=await custody.prepare(kind,payload,current),schema=socialMediaResponses[path];
  if(!schema)throw Error('Unsupported media command');
  const answer=await client.request(path,schema,{...payload,commandId:held.commandId},()=>{current();custody.assert(held);});
  if(!client.isCurrent(epoch))throw Error('Social authority changed');
  custody.complete(held);
  const parsed=socialCommandResult(z.unknown()).parse(answer);
  if(parsed.status==='refused')throw Error(parsed.reason);
  return parsed.result;
 });
 return {
  read:async()=>{const result=await client.request('/social/media/list',socialMediaListSchema,{},current);current();return result.media;},
  upload:async file=>{
   const epoch=client.epoch;
   if(file.size===0||file.size>20*1024*1024)throw Error('Choose one supported image up to 20 MiB');
   const bytes=await file.arrayBuffer();if(!client.isCurrent(epoch))throw Error('Social authority changed');
   const digest=await crypto.subtle.digest('SHA-256',bytes);if(!client.isCurrent(epoch))throw Error('Social authority changed');
   const sha256=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
   const payload=registerSocialAssetSchema.parse({sha256,bytes:file.size,mime:file.type,origin:{kind:'upload',sourceUrl:null,usageNote:null}});
   const result=await command('register','/social/assets/register',payload);
   const registered=registeredSchema.parse({status:'accepted',replayed:false,result});
   if(registered.status!=='accepted')throw Error('Upload unavailable');
   await client.uploadSocialAsset(registered.result,file,current);
   if(!client.isCurrent(epoch))throw Error('Social authority changed');
   await command('complete','/social/media/complete',registered.result);
  },
  preview:async binding=>{const result=await client.request('/social/media/preview',socialMediaSignedPreviewSchema,{assetId:binding.assetId,version:binding.version,sha256:binding.sha256},current);current();return result;},
  approve:async input=>{await command('approve','/social/media/approve',socialMediaApproveInputSchema.parse(input));},
  remove:async input=>{await command('withdraw','/social/media/withdraw',input);},
  reconcile:()=>custody.exclusive(async()=>{
   const held=custody.read();if(!held)return 'accepted';
   const result=await client.request('/social/media/receipt',socialMediaReceiptSchema,{kind:held.kind,commandId:held.commandId,payloadSHA256:held.payloadSHA256},()=>{current();custody.assert(held);});current();
   if(result.state!=='unknown')custody.complete(held);return result.state;
  }),
  subscribe:clear=>{let epoch=client.epoch;return client.subscribe(()=>{if(epoch!==client.epoch||client.current?.status!=='signed_in'){epoch=client.epoch;custody.clear();clear();}});},
 };
}
