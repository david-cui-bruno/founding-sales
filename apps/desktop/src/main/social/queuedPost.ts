import {z} from 'zod';
import {socialAssetViewSchema,socialDeliveryQueueSchema,socialWorkspaceSchema,type SocialDeliveryQueue} from '@fss/contracts';
import type {AuthedClient} from '../authedClient.ts';
import type {ApprovedPost} from './adapters.ts';
import {withSocialImages} from './materializeImages.ts';
interface Ports {api:AuthedClient;root:string;current():boolean;adapterVersion:string;send?:typeof fetch}
/** Read-only resolution of the immutable queue snapshot into private adapter inputs.
 * The caller must still claim/revalidate approval before submission. No adapter is enabled here.
 */
export async function withQueuedSocialPost<T>(input:SocialDeliveryQueue['items'][number],port:Ports,use:(post:ApprovedPost)=>Promise<T>):Promise<T>{
 const item=socialDeliveryQueueSchema.parse({items:[input]}).items[0]!;
 const check=()=>{if(!port.current())throw new Error('session_changed');};
 async function read<R>(path:string,parse:(value:unknown)=>R,body:Record<string,unknown>){check();const result=await port.api.read(path,parse,body);check();if(!result.ok)throw new Error('delivery_input_unavailable');return result.value;}
 const workspace=await read('/social',v=>socialWorkspaceSchema.parse(v),{});
 const approved=item.snapshot.account;
 const accounts=workspace.accounts.filter(a=>a.id===approved.id);
 const account=accounts.length===1?accounts[0]:undefined;
 if(!account||account.state!=='connected'||!account.verifiedAt||account.platform!==approved.platform||account.externalId!==approved.externalId||account.adapterVersion!==approved.adapterVersion||port.adapterVersion!==approved.adapterVersion)throw new Error('account_not_verified');
 const images:Parameters<typeof withSocialImages>[0]=[];
 for(const approvedImage of item.snapshot.images){
  const {asset}=await read('/social/assets/read',v=>z.strictObject({asset:socialAssetViewSchema}).parse(v),{assetId:approvedImage.assetId});
  const objects=asset.objects.filter(o=>o.version===approvedImage.version&&o.kind==='derivative'&&o.state==='ready');
  const image=objects.length===1?objects[0]:undefined;
  if(asset.id!==approvedImage.assetId||asset.state!=='ready'||!image||image.sha256!==approvedImage.sha256||image.mime!==approvedImage.mime||image.width!==approvedImage.width||image.height!==approvedImage.height)throw new Error('approved_image_changed');
  const location=await read('/social/assets/download-url',v=>z.strictObject({url:z.string().url(),expiresAt:z.string().datetime()}).parse(v),{assetId:approvedImage.assetId,version:approvedImage.version});
  images.push({...approvedImage,bytes:image.bytes,location});
 }
 check();
 return withSocialImages(images,port,async files=>{
  check();return use({deliveryId:item.deliveryId,postId:item.postId,revision:item.revision,account:{platform:account.platform,externalId:account.externalId,displayName:account.displayName},text:item.snapshot.text,images:files,publishAt:item.snapshot.publishAt,zone:item.snapshot.zone,fingerprint:item.fingerprint});
 });
}
