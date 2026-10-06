import {stageLinkedInPost} from './linkedinPostStage.ts';
import {linkedInMediaCaptureScript} from './linkedinMediaCapture.ts';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {AccountIdentity,ApprovedPost,InspectionResult,SocialAdapter} from '../adapters.ts';
import type {SocialAdapterContext} from '../deliveryRunner.ts';
import {stageLinkedInText} from './linkedinStage.ts';
import {linkedInSubmitScript} from './linkedinSubmit.ts';
import {inspectLinkedInTextReceipt,inspectLinkedInImageReceipt,inspectLinkedInSubmittedImage} from './linkedinReceiptInspection.ts';
import {cancelLinkedInReceipt} from './linkedinCancel.ts';
type StagePort=Parameters<typeof stageLinkedInText>[1];
interface Port extends StagePort {
 /** Identity read must not navigate away from an existing staged composer. */
 account():Promise<AccountIdentity|null>;
 /** Read-only settlement; never navigate while the attempted save is in flight. */
 waitForSave():Promise<boolean>;
 openComposer():Promise<void>;openScheduledList():Promise<void>;
 list():Promise<unknown>;detail(receiptId:string):Promise<unknown>;
 published?(receiptId:string):Promise<unknown>;
}
/** Text-only submission with persisted-image recovery. Not a verified registration: native navigation
 * ports and the product-owned session still need platform acceptance.
 */
export function createLinkedInTextAdapter(raw:SocialAdapterContext,port:Port):SocialAdapter{return createAdapter(raw,port);}
/** Unregistered single-image path; requires native provenance acceptance before activation. */
export function createLinkedInImageAdapter(raw:SocialAdapterContext,port:Port&{root:string}):SocialAdapter{return createAdapter(raw,port,port.root);}
function createAdapter(raw:SocialAdapterContext,port:Port,imageRoot?:string):SocialAdapter{
 const context=structuredClone(raw),snapshot=context.snapshot;
 let staged=false,attempted=false;
 let baseline:string[]|null=null,submissionToken:string|null=null,capture:{sha256:string;platformId:string}|null=null;
 const unknown=():InspectionResult=>({state:'unknown',receiptId:null,permalink:null,observedAt:new Date(port.now()).toISOString(),accountExternalId:null,observedFingerprint:null,complete:false});
 const same=async()=>{const a=await port.account();return port.current()&&a?.platform==='linkedin'&&a.externalId===snapshot.account.externalId&&a.displayName===context.displayName;};
 const exact=(p:ApprovedPost)=>snapshot.account.platform==='linkedin'&&(imageRoot===undefined?snapshot.images.length===0&&p.images.length===0:snapshot.images.length===1&&p.images.length===1&&snapshot.images.every((image,i)=>image.assetId===p.images[i]!.assetId&&image.version===p.images[i]!.version&&image.sha256===p.images[i]!.sha256&&image.altText===p.images[i]!.altText))&&p.account.platform==='linkedin'&&p.account.externalId===snapshot.account.externalId&&p.account.displayName===context.displayName&&p.text===snapshot.text&&p.publishAt===snapshot.publishAt&&p.zone===snapshot.zone&&p.fingerprint===context.fingerprint;
 const label=(list:boolean)=>{const f=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:snapshot.zone,year:'numeric',month:'short',weekday:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(new Date(snapshot.publishAt)).map(p=>[p.type,p.value]));return list?`Posting ${f['weekday']}, ${f['month']} ${f['day']}, ${f['year']} at ${f['hour']}:${f['minute']} ${f['dayPeriod']}`:`Posting at ${f['weekday']}, ${f['month']} ${f['day']}, ${f['hour']}:${f['minute']} ${f['dayPeriod']}`;};
 const adapter:SocialAdapter={
 inspectAccount:async()=>port.current()?port.account():null,
 async stage(post){
  if(!exact(post)||attempted||!port.current())return {ready:false,reason:'approval_or_session_changed'};
  staged=false;
  try{if(!await same())return {ready:false,reason:'account_identity_changed'};
   if(imageRoot!==undefined){
    baseline=null;await port.openScheduledList();
    const list=z.object({ok:z.literal(true),complete:z.literal(true),total:z.number().int().nonnegative(),rows:z.array(z.object({receiptId:z.string().regex(/^urn:li:share:\d+$/)})).max(100)}).parse(await port.list());
    if(list.total!==list.rows.length||new Set(list.rows.map(r=>r.receiptId)).size!==list.total||!await same())return {ready:false,reason:'baseline_unverified'};
    baseline=list.rows.map(r=>r.receiptId);
   }
   await port.openComposer();if(!port.current())return {ready:false,reason:'session_changed'};const result=imageRoot===undefined?await stageLinkedInText(post,port):await stageLinkedInPost(post,{...port,root:imageRoot});staged=result.ready&&port.current();return result;}catch{return {ready:false,reason:'staging_unavailable'};}
 },
 async submit(post){
  if(!staged||attempted||!exact(post)||!port.current()||Date.parse(snapshot.publishAt)<=port.now())return {kind:'not_submitted',reason:'submission_not_ready'};
  try{
   if(!await same()||Date.parse(snapshot.publishAt)<=port.now())return {kind:'not_submitted',reason:'account_or_schedule_changed'};
   attempted=true;staged=false;submissionToken=randomUUID();
   await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInSubmitScript({token:submissionToken,...(imageRoot!==undefined?{image:{sha256:snapshot.images[0]!.sha256,altText:snapshot.images[0]!.altText}}:{}),postingName:context.displayName,text:snapshot.text,zone:snapshot.zone,scheduleLabel:label(false)})}],false);
   // A click, including a lost response, never supplies a native receipt.
   return {kind:'unknown'};
  }catch{return {kind:'unknown'};}
 },
 async inspect(input){
  if(input.fingerprint!==context.fingerprint||!port.current())return unknown();
  try{
   if(attempted&&!await port.waitForSave())return unknown();
   if(snapshot.images.length&&!context.mediaBinding&&!capture){
    if(imageRoot===undefined||!attempted||!submissionToken||!baseline)return unknown();
    const result=z.strictObject({ok:z.literal(true),view:z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/),platformId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)})}).parse(await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInMediaCaptureScript({action:'read',token:submissionToken,sha256:snapshot.images[0]!.sha256,altText:snapshot.images[0]!.altText})}],false));
    if(!port.current())return unknown();capture=result.view;
   }
   if(!await same())return unknown();await port.openScheduledList();if(!port.current())return unknown();
   if(snapshot.images.length){
    const expected={accountExternalId:snapshot.account.externalId,postingName:context.displayName,text:snapshot.text,publishAt:snapshot.publishAt,fingerprint:context.fingerprint,images:snapshot.images.map(i=>({sha256:i.sha256,altText:i.altText}))};
    if(!context.mediaBinding&&capture&&baseline){
     const first=await inspectLinkedInSubmittedImage(expected,capture,baseline,{...port,account:async()=>await same()?snapshot.account.externalId:null});
     if(input.receiptId!==null&&first.receiptId!==input.receiptId)return unknown();
     if(first.complete&&first.mediaBinding)context.mediaBinding=first.mediaBinding;
     return first;
    }
    const binding=context.mediaBinding;
    if(!binding||(input.receiptId!==null&&input.receiptId!==binding.receiptId))return unknown();
    return inspectLinkedInImageReceipt({accountExternalId:snapshot.account.externalId,postingName:context.displayName,text:snapshot.text,publishAt:snapshot.publishAt,fingerprint:context.fingerprint,images:snapshot.images.map(i=>({sha256:i.sha256,altText:i.altText}))},binding,{...port,account:async()=>await same()?snapshot.account.externalId:null});
   }
   const scheduled=await inspectLinkedInTextReceipt({accountExternalId:snapshot.account.externalId,postingName:context.displayName,text:snapshot.text,publishAt:snapshot.publishAt,fingerprint:context.fingerprint,images:[]},input.receiptId,{...port,account:async()=>await same()?snapshot.account.externalId:null});
   if(scheduled.state==='scheduled')return scheduled;
   if(!port.published||!input.receiptId||!/^urn:li:share:\d+$/.test(input.receiptId)||Date.parse(snapshot.publishAt)>port.now()||!port.current())return unknown();
   const result=z.strictObject({ok:z.literal(true),view:z.strictObject({shareId:z.string(),activityId:z.string().regex(/^urn:li:activity:\d+$/),authorExternalId:z.string(),text:z.string().max(10000),permalink:z.string(),publishedAt:z.null()})}).parse(await port.published(input.receiptId));
   const v=result.view;
   if(!port.current()||v.shareId!==input.receiptId||v.authorExternalId!==snapshot.account.externalId||v.text!==snapshot.text||v.permalink!==`https://www.linkedin.com/feed/update/${v.activityId}/`||!await same())return unknown();
   return {state:'published',receiptId:input.receiptId,permalink:v.permalink,observedAt:new Date(port.now()).toISOString(),accountExternalId:snapshot.account.externalId,observedFingerprint:context.fingerprint,complete:true};
  }catch{return unknown();}
 },
 async cancel(receiptId){
  // Reinspect at cancellation time; never rely on a stale earlier success.
  const proof=await adapter.inspect({receiptId,fingerprint:context.fingerprint});
  if(!proof.complete||proof.state!=='scheduled'||proof.receiptId!==receiptId||!port.current())return unknown();
  try{
   await port.openScheduledList();if(!port.current())return unknown();
   const result=await cancelLinkedInReceipt({receiptId,text:snapshot.text,scheduleLabel:label(true)},{...port,accountMatches:same});
   // An already-absent row may have published between reads, so it is unknown.
   if(result.state!=='cancelled'||!port.current())return unknown();
   return {...proof,state:'cancelled',observedAt:new Date(port.now()).toISOString()};
  }catch{return unknown();}
 }
 };
 return adapter;
}
