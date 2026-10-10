import {socialDiagnosticEventSchema,socialDiagnosticReason,type SocialDiagnosticReporter,type SocialDiagnosticAttempt,type SocialDiagnosticEvent} from '../../shared/socialDiagnostics.ts';
import {socialDeliveryQueueSchema,socialWorkspaceSchema,socialPostRevisionSchema,type SocialDeliveryQueue} from '@fss/contracts';
import type {AuthedClient} from '../authedClient.ts';
import type {SocialAdapter} from './adapters.ts';
import type {SocialPlatform,SocialScope} from './runtime.ts';
import {withQueuedSocialPost} from './queuedPost.ts';
import {createSocialDeliveryPorts} from './deliveryApi.ts';
import {submitApprovedSocialPost,reconcileSocialPost} from './deliveryLoop.ts';
export interface SocialAdapterContext {mediaBinding?:SocialDeliveryQueue['items'][number]['mediaBinding'];snapshot:SocialDeliveryQueue['items'][number]['snapshot'];fingerprint:string;displayName:string;diagnostic?:SocialDiagnosticReporter}
/** Register only adapters that have passed native schedule/receipt/cancel acceptance. */
export interface VerifiedSocialAdapter {
 version:string;
 check?(scope:SocialScope,expected:{platform:SocialPlatform;externalId:string;displayName:string},diagnostic:SocialDiagnosticReporter):Promise<unknown>;
 open(scope:SocialScope,run:(adapter:SocialAdapter,current:()=>boolean)=>Promise<void>,context:SocialAdapterContext):Promise<unknown>;
}
interface Deps {api:AuthedClient;root:string;identity():Promise<{workspaceId:string;userId:string}|null>;now():number;adapters:Partial<Record<SocialPlatform,VerifiedSocialAdapter>>;send?:typeof fetch}
export function createSocialDeliveryRunner(deps:Deps){
 const diagnostics=new Map<string,SocialDiagnosticAttempt>();
 let queue:'unread'|'available'|'unavailable'='unread',lastReadAt:string|null=null,statusEpoch=0;
 return {
 status(){return {queue,lastReadAt,...(diagnostics.size?{diagnostics:structuredClone([...diagnostics.values()])}:{})};},
 clearAccount(accountId:string){for(const [key,value] of diagnostics)if(value.accountId===accountId)diagnostics.delete(key);},
 resetStatus(){diagnostics.clear();statusEpoch++;queue='unread';lastReadAt=null;},
 async checkPreparation(accountId:string){
  const epoch=statusEpoch,identity=await deps.identity();const events:SocialDiagnosticEvent[]=[];
  if(!identity||epoch!==statusEpoch)return {ready:false,reason:'session_changed',events};
  const view=await deps.api.read('/social',v=>socialWorkspaceSchema.parse(v),{});
  if(epoch!==statusEpoch||!view.ok)return {ready:false,reason:'preparation_unavailable',events:[]};
  const account=view.value.accounts.find(a=>a.id===accountId),adapter=account?deps.adapters[account.platform]:undefined;
  if(!account||account.state!=='connected'||!adapter?.check||adapter.version!==account.adapterVersion)return {ready:false,reason:'preparation_unavailable',events};
  const diagnostic:SocialDiagnosticReporter=(stage,outcome,reason)=>{if(epoch!==statusEpoch)return;events.push(socialDiagnosticEventSchema.parse({stage,outcome,reason:socialDiagnosticReason(reason),at:new Date(deps.now()).toISOString()}));if(events.length>32)events.shift();};
  try{const result=await adapter.check({...identity,accountId,platform:account.platform},{platform:account.platform,externalId:account.externalId,displayName:account.displayName},diagnostic);
   const fresh=await deps.api.read('/social',v=>socialWorkspaceSchema.parse(v),{});const latest=fresh.ok?fresh.value.accounts.find(a=>a.id===accountId):null;
   if(epoch!==statusEpoch||!latest||latest.state!=='connected'||latest.externalId!==account.externalId||latest.displayName!==account.displayName||latest.adapterVersion!==account.adapterVersion)return {ready:false,reason:'session_changed',events:[]};
   if(result!==null&&typeof result==='object'&&'ready' in result&&result.ready===true)return {ready:true,reason:null,events};
   const reason=result!==null&&typeof result==='object'&&'reason' in result&&typeof result.reason==='string'?socialDiagnosticReason(result.reason):'preparation_unavailable';return {ready:false,reason,events};
  }catch{return epoch!==statusEpoch?{ready:false,reason:'session_changed',events:[]}:{ready:false,reason:'preparation_unavailable',events};}
 },
 async read():Promise<SocialDeliveryQueue>{const epoch=statusEpoch;try{const result=await deps.api.read('/social/delivery/queue',v=>socialDeliveryQueueSchema.parse(v),{});if(!result.ok)throw new Error('queue_unavailable');if(epoch===statusEpoch){queue='available';lastReadAt=new Date(deps.now()).toISOString();}
  if(diagnostics.size){const inventory=await deps.api.read('/social',v=>socialWorkspaceSchema.parse(v),{});if(epoch===statusEpoch){if(!inventory.ok)diagnostics.clear();else for(const [id,attempt] of diagnostics){if(!inventory.value.posts.some(p=>p.postId===id&&p.revision===attempt.revision&&p.accountId===attempt.accountId)||!inventory.value.accounts.some(a=>a.id===attempt.accountId&&a.state!=='disconnected'))diagnostics.delete(id);}}}
 return result.value;}catch{if(epoch===statusEpoch)queue='unavailable';throw new Error('queue_unavailable');}},
 async run(input:SocialDeliveryQueue['items'][number],current:()=>boolean):Promise<void>{
  if(!current())return;
  const item=socialDeliveryQueueSchema.parse({items:[input]}).items[0]!;
  const approved=item.snapshot.account,registration=deps.adapters[approved.platform];
  const identity=await deps.identity();if(!identity||!current())return;
  const hold=async(reason:string)=>{if(!current()||item.submissionId!==null||item.receiptId!==null)return;await deps.api.command('/social/delivery/hold',{postId:item.postId,expectedRevision:item.revision,reason},v=>socialPostRevisionSchema.parse(v));};
  if(!registration||registration.version!==approved.adapterVersion){await hold('adapter_unavailable');return;}
  const scope={...identity,platform:approved.platform,accountId:approved.id};
  const epoch=statusEpoch,attempt:SocialDiagnosticAttempt={postId:item.postId,accountId:approved.id,revision:item.revision,events:[]};
  diagnostics.delete(item.postId);diagnostics.set(item.postId,attempt);while(diagnostics.size>25)diagnostics.delete(diagnostics.keys().next().value!);
  const diagnostic:SocialDiagnosticReporter=(stage,outcome,reason)=>{if(!current()||epoch!==statusEpoch||diagnostics.get(item.postId)!==attempt)return;attempt.events.push({stage,outcome,reason:socialDiagnosticReason(reason),at:new Date(deps.now()).toISOString()});if(attempt.events.length>32)attempt.events.shift();};
  if(item.action==='submit'){
   // Queue rows with a durable marker can never return to a submission path.
   if(item.submissionId!==null||item.receiptId!==null)return;
   try{await withQueuedSocialPost(item,{api:deps.api,root:deps.root,current,adapterVersion:registration.version,...(deps.send?{send:deps.send}:{})},async post=>{
    if(!current())return;
    let deliveryEntered=false;diagnostic('browser_load','started');
    const opened=await registration.open(scope,async(adapter,browserCurrent)=>{
     deliveryEntered=true;diagnostic('browser_load','succeeded');
     const active=()=>current()&&browserCurrent();if(!active())return;
     const result=await submitApprovedSocialPost(post,adapter,createSocialDeliveryPorts({api:deps.api,current:active,now:deps.now}),diagnostic);
     if(result.state==='not_submitted'&&active()){
      const reason=result.reason==='staging_unavailable'?'staging_failed':['schedule_missed','account_identity_changed','staging_failed','claim_expired'].includes(result.reason)?result.reason:'preparation_unavailable';
      await hold(reason);
     }
    },{snapshot:structuredClone(item.snapshot),fingerprint:item.fingerprint,displayName:post.account.displayName,diagnostic});
    // Returned timeouts need recovery too. Busy/changed sessions remain untouched.
    // The server freshly refuses this hold if a submission marker already exists.
    if(opened!==null&&typeof opened==='object'&&'ok' in opened&&opened.ok===false&&'reason' in opened){diagnostic(deliveryEntered?'preparation':'browser_load','refused',typeof opened.reason==='string'?opened.reason:'unknown');if(opened.reason==='browser_unavailable')await hold('preparation_unavailable');}
   });}catch(error){
    const reason=error instanceof Error&&['account_not_verified','approved_image_changed'].includes(error.message)?error.message:'preparation_unavailable';
    diagnostic('preparation','refused',reason);await hold(reason);
   }return;
  }
  if(!item.submissionId)return;
  // Recovery depends on receipt identity, never on retained/downloadable image files.
  const result=await deps.api.read('/social',v=>socialWorkspaceSchema.parse(v),{});if(!current()||!result.ok)return;
  const accounts=result.value.accounts.filter(a=>a.id===approved.id),account=accounts.length===1?accounts[0]:undefined;
  if(!account||account.state==='disconnected'||account.externalId!==approved.externalId||account.platform!==approved.platform)return;
  await registration.open(scope,async(adapter,browserCurrent)=>{
   const active=()=>current()&&browserCurrent();if(!active())return;
   await reconcileSocialPost({account:{platform:account.platform,externalId:account.externalId,displayName:account.displayName},fingerprint:item.fingerprint},{submissionId:item.submissionId!,receiptId:item.receiptId,cancel:item.action==='cancel'},adapter,createSocialDeliveryPorts({api:deps.api,current:active,now:deps.now}),diagnostic);
  },{snapshot:structuredClone(item.snapshot),fingerprint:item.fingerprint,displayName:account.displayName,mediaBinding:item.mediaBinding??null,diagnostic});
 },
 };
}
