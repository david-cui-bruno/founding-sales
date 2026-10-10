import {socialDeliveryQueueSchema,socialWorkspaceSchema,socialPostRevisionSchema,type SocialDeliveryQueue} from '@fss/contracts';
import type {AuthedClient} from '../authedClient.ts';
import type {SocialAdapter} from './adapters.ts';
import type {SocialPlatform,SocialScope} from './runtime.ts';
import {withQueuedSocialPost} from './queuedPost.ts';
import {createSocialDeliveryPorts} from './deliveryApi.ts';
import {submitApprovedSocialPost,reconcileSocialPost} from './deliveryLoop.ts';
export interface SocialAdapterContext {mediaBinding?:SocialDeliveryQueue['items'][number]['mediaBinding'];snapshot:SocialDeliveryQueue['items'][number]['snapshot'];fingerprint:string;displayName:string}
/** Register only adapters that have passed native schedule/receipt/cancel acceptance. */
export interface VerifiedSocialAdapter {
 version:string;
 open(scope:SocialScope,run:(adapter:SocialAdapter,current:()=>boolean)=>Promise<void>,context:SocialAdapterContext):Promise<unknown>;
}
interface Deps {api:AuthedClient;root:string;identity():Promise<{workspaceId:string;userId:string}|null>;now():number;adapters:Partial<Record<SocialPlatform,VerifiedSocialAdapter>>;send?:typeof fetch}
export function createSocialDeliveryRunner(deps:Deps){
 let queue:'unread'|'available'|'unavailable'='unread',lastReadAt:string|null=null,statusEpoch=0;
 return {
 status(){return {queue,lastReadAt};},
 resetStatus(){statusEpoch++;queue='unread';lastReadAt=null;},
 async read():Promise<SocialDeliveryQueue>{const epoch=statusEpoch;try{const result=await deps.api.read('/social/delivery/queue',v=>socialDeliveryQueueSchema.parse(v),{});if(!result.ok)throw new Error('queue_unavailable');if(epoch===statusEpoch){queue='available';lastReadAt=new Date(deps.now()).toISOString();}return result.value;}catch{if(epoch===statusEpoch)queue='unavailable';throw new Error('queue_unavailable');}},
 async run(input:SocialDeliveryQueue['items'][number],current:()=>boolean):Promise<void>{
  if(!current())return;
  const item=socialDeliveryQueueSchema.parse({items:[input]}).items[0]!;
  const approved=item.snapshot.account,registration=deps.adapters[approved.platform];
  const identity=await deps.identity();if(!identity||!current())return;
  const hold=async(reason:string)=>{if(!current()||item.submissionId!==null||item.receiptId!==null)return;await deps.api.command('/social/delivery/hold',{postId:item.postId,expectedRevision:item.revision,reason},v=>socialPostRevisionSchema.parse(v));};
  if(!registration||registration.version!==approved.adapterVersion){await hold('adapter_unavailable');return;}
  const scope={...identity,platform:approved.platform,accountId:approved.id};
  if(item.action==='submit'){
   // Queue rows with a durable marker can never return to a submission path.
   if(item.submissionId!==null||item.receiptId!==null)return;
   try{await withQueuedSocialPost(item,{api:deps.api,root:deps.root,current,adapterVersion:registration.version,...(deps.send?{send:deps.send}:{})},async post=>{
    if(!current())return;
    let deliveryEntered=false;
    const opened=await registration.open(scope,async(adapter,browserCurrent)=>{
     deliveryEntered=true;
     const active=()=>current()&&browserCurrent();if(!active())return;
     const result=await submitApprovedSocialPost(post,adapter,createSocialDeliveryPorts({api:deps.api,current:active,now:deps.now}));
     if(result.state==='not_submitted'&&active()){
      const reason=result.reason==='staging_unavailable'?'staging_failed':['schedule_missed','account_identity_changed','staging_failed','claim_expired'].includes(result.reason)?result.reason:'preparation_unavailable';
      await hold(reason);
     }
    },{snapshot:structuredClone(item.snapshot),fingerprint:item.fingerprint,displayName:post.account.displayName});
    // Runtime failures are returned, not thrown. A busy/changed session is not
    // permission to fail another operation; once delivery starts it owns marker recovery.
    if(!deliveryEntered&&opened!==null&&typeof opened==='object'&&'ok' in opened&&opened.ok===false&&'reason' in opened&&opened.reason==='browser_unavailable')await hold('preparation_unavailable');
   });}catch(error){
    const reason=error instanceof Error&&['account_not_verified','approved_image_changed'].includes(error.message)?error.message:'preparation_unavailable';
    await hold(reason);
   }return;
  }
  if(!item.submissionId)return;
  // Recovery depends on receipt identity, never on retained/downloadable image files.
  const result=await deps.api.read('/social',v=>socialWorkspaceSchema.parse(v),{});if(!current()||!result.ok)return;
  const accounts=result.value.accounts.filter(a=>a.id===approved.id),account=accounts.length===1?accounts[0]:undefined;
  if(!account||account.state==='disconnected'||account.externalId!==approved.externalId||account.platform!==approved.platform)return;
  await registration.open(scope,async(adapter,browserCurrent)=>{
   const active=()=>current()&&browserCurrent();if(!active())return;
   await reconcileSocialPost({account:{platform:account.platform,externalId:account.externalId,displayName:account.displayName},fingerprint:item.fingerprint},{submissionId:item.submissionId!,receiptId:item.receiptId,cancel:item.action==='cancel'},adapter,createSocialDeliveryPorts({api:deps.api,current:active,now:deps.now}));
  },{snapshot:structuredClone(item.snapshot),fingerprint:item.fingerprint,displayName:account.displayName,mediaBinding:item.mediaBinding??null});
 },
 };
}
