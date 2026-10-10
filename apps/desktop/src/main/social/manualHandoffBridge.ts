import {z} from 'zod';
import sharp from 'sharp';
import {socialManualHandoffViewSchema,socialManualHandoffInputSchema,socialManualHandoffConfirmSchema,socialManualHandoffUseSchema,socialManualHandoffApprovalSchema,socialAssetViewSchema,type SocialManualHandoffView} from '@fss/contracts';
import type {AuthedClient} from '../authedClient.ts';
import {fetchSocialImageBytes} from './imageThumbnail.ts';

interface Ports {
 api:AuthedClient;generation():number;copy(text:string):Promise<void>;open(url:string):Promise<void>;
 chooseDestination(suggestedName:string):Promise<string|null>;
 write(path:string,bytes:Uint8Array):Promise<void>;send?:typeof fetch;
}
const urls={linkedin:'https://www.linkedin.com/feed/',facebook:'https://www.facebook.com/',x:'https://x.com/compose/post'};
const response=z.strictObject({view:socialManualHandoffViewSchema});
const result=(reason:string|null)=>({accepted:reason===null,reason});
const confirmInput=socialManualHandoffConfirmSchema.extend({commandId:z.string().uuid()});
const safeReason=(error:unknown)=>{const reason=error instanceof Error?error.message:'';return ['session_changed','approval_changed','approved_image_changed','image_unavailable','unsupported_image','image_checksum_mismatch','image_size_mismatch','schedule_in_past','stale_revision','inspect_existing_submission','image_unavailable','manual_handoff_not_draft','destination_disconnected','content_needs_edit','not_found'].includes(reason)?reason:'manual_handoff_unavailable';};

/** Main owns exact server text, signed URLs and native paths. Renderer supplies
 * only reviewed opaque identifiers; a handoff never dispatches to a provider. */
export function createSocialManualHandoffBridge(port:Ports){
 let busy=false;
 async function checkedRead(raw:unknown,current:()=>boolean):Promise<SocialManualHandoffView>{
  if(!current())throw new Error('session_changed');
  const input=socialManualHandoffInputSchema.parse(raw),answer=await port.api.read('/social/manual-handoff/read',v=>response.parse(v),input);
  if(!current())throw new Error('session_changed');if(!answer.ok)throw new Error(answer.reason);
  const view=answer.value.view;if(view.postId!==input.postId||view.revision!==input.expectedRevision)throw new Error('approval_changed');return view;
 }
 async function read(raw:unknown){const generation=port.generation();try{return {view:await checkedRead(raw,()=>port.generation()===generation),reason:null};}catch(error){return {view:null,reason:safeReason(error)};}}
 async function confirm(raw:unknown){const generation=port.generation(),current=()=>port.generation()===generation;
  try{const input=confirmInput.parse(raw);if(!current())throw new Error('session_changed');
   const {commandId,...payload}=input,answer=await port.api.command('/social/manual-handoff/confirm',payload,v=>socialManualHandoffApprovalSchema.parse(v),{commandId});
   if(!current())return {...result('session_changed'),approvalId:null};
   return answer.ok?{...result(null),approvalId:answer.value.approvalId}:{...result(answer.reason),approvalId:null};
  }catch{return {...result(current()?'manual_handoff_unavailable':'session_changed'),approvalId:null};}
 }
 async function use(raw:unknown){if(busy)return result('handoff_busy');busy=true;const generation=port.generation(),current=()=>port.generation()===generation;
  try{
   const input=socialManualHandoffUseSchema.parse(raw);
   const verify=async()=>{const view=await checkedRead({postId:input.postId,expectedRevision:input.expectedRevision},current);if(view.state!=='manual_needed'||view.approvalId!==input.approvalId||view.fingerprint!==input.fingerprint)throw new Error('approval_changed');return view;};
   const view=await verify();
   if(input.action==='copy'){if(!current())throw new Error('session_changed');await port.copy(view.snapshot.text);}
   else if(input.action==='open'){if(!current())throw new Error('session_changed');await port.open(urls[view.snapshot.account.platform]);}
   else{
    const approved=view.snapshot.images.find(image=>image.assetId===input.image!.assetId&&image.version===input.image!.version);if(!approved)throw new Error('approved_image_changed');
    const name=`Callie-${approved.assetId}-v${approved.version}.${approved.mime==='image/png'?'png':'jpg'}`;
    const path=await port.chooseDestination(name);if(!current())throw new Error('session_changed');if(path===null)return result('handoff_cancelled');
    const assetAnswer=await port.api.read('/social/assets/read',v=>z.strictObject({asset:socialAssetViewSchema}).parse(v),{assetId:approved.assetId});
    if(!current())throw new Error('session_changed');if(!assetAnswer.ok)throw new Error('image_unavailable');
    const asset=assetAnswer.value.asset,objects=asset.objects.filter(image=>image.version===approved.version&&image.kind==='derivative'&&image.state==='ready'),image=objects.length===1?objects[0]:undefined;
    if(asset.id!==approved.assetId||asset.state!=='ready'||!image||image.sha256!==approved.sha256||image.mime!==approved.mime||image.width!==approved.width||image.height!==approved.height)throw new Error('approved_image_changed');
    const location=await port.api.read('/social/assets/download-url',v=>z.strictObject({url:z.string().url(),expiresAt:z.string().datetime()}).parse(v),{assetId:approved.assetId,version:approved.version});
    if(!current())throw new Error('session_changed');if(!location.ok)throw new Error('image_unavailable');
    const bytes=await fetchSocialImageBytes(location.value,image,port.send);if(!current())throw new Error('session_changed');
    const metadata=await sharp(bytes,{limitInputPixels:4096*4096,failOn:'warning'}).metadata();
    if((metadata.format==='png'?'image/png':metadata.format==='jpeg'?'image/jpeg':null)!==approved.mime||(metadata.pages??1)!==1||metadata.width!==approved.width||metadata.height!==approved.height||metadata.exif||metadata.xmp||metadata.iptc)throw new Error('unsupported_image');
    await verify();if(!current())throw new Error('session_changed');await port.write(path,bytes);
   }
   return result(current()?null:'session_changed');
  }catch(error){return result(!current()?'session_changed':safeReason(error));}
  finally{busy=false;}
 }
 return {read,confirm,use};
}
