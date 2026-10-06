import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {registerSocialAssetSchema,uuid,type RegisterSocialAsset} from '@fss/contracts';
import type {AuthedClient} from '../authedClient.ts';
export const socialUploadCheckpointSchema=z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/u),registrationCommandId:uuid,completionCommandId:uuid,assetId:uuid.nullable(),uploadId:uuid.nullable(),version:z.number().int().positive().nullable()});
export type SocialUploadCheckpoint=z.infer<typeof socialUploadCheckpointSchema>;
export function createSocialUploadCheckpoint(sha256:string):SocialUploadCheckpoint {
 return socialUploadCheckpointSchema.parse({sha256,registrationCommandId:randomUUID(),completionCommandId:randomUUID(),assetId:null,uploadId:null,version:null});
}
const locationSchema=z.strictObject({url:z.string().url(),headers:z.record(z.string(),z.string()),expiresAt:z.string().datetime()});
type Location=z.infer<typeof locationSchema>;
interface UploadPorts {
 api:AuthedClient;
 isCurrent():boolean;
 /** Atomically persist in the selected owner's private staging directory before continuing. */
 save(checkpoint:SocialUploadCheckpoint):Promise<void>;
 put?(location:Location,bytes:Buffer):Promise<{status:number}>;
}
export async function uploadSocialAssetVersion(deps:UploadPorts,input:RegisterSocialAsset,bytes:Buffer,raw:SocialUploadCheckpoint):Promise<{ok:true;assetId:string;version:number}|{ok:false;reason:string}> {
 const parsed=registerSocialAssetSchema.safeParse(input),saved=socialUploadCheckpointSchema.safeParse(raw);
 if(!parsed.success||!saved.success)return {ok:false,reason:'invalid_image'};
 const checkpoint=saved.data;
 if(bytes.length!==input.bytes||input.sha256!==checkpoint.sha256||createHash('sha256').update(bytes).digest('hex')!==input.sha256)return {ok:false,reason:'image_changed'};
 if(!deps.isCurrent())return {ok:false,reason:'session_changed'};
 try {
  await deps.save(checkpoint);
  if(!deps.isCurrent())return {ok:false,reason:'session_changed'};
  if(!checkpoint.assetId||!checkpoint.uploadId){
   const answer=await deps.api.command('/social/assets/register',parsed.data,v=>z.strictObject({assetId:uuid,uploadId:uuid}).parse(v),{commandId:checkpoint.registrationCommandId});
   if(!deps.isCurrent())return {ok:false,reason:'session_changed'};
   if(!answer.ok)return {ok:false,reason:answer.reason};
   checkpoint.assetId=answer.value.assetId;checkpoint.uploadId=answer.value.uploadId;
   await deps.save(checkpoint);
  }
  if(!deps.isCurrent())return {ok:false,reason:'session_changed'};
  if(checkpoint.version!==null)return {ok:true,assetId:checkpoint.assetId,version:checkpoint.version};
  const location=await deps.api.read('/social/assets/upload-url',v=>locationSchema.parse(v),{assetId:checkpoint.assetId,uploadId:checkpoint.uploadId});
  if(!deps.isCurrent())return {ok:false,reason:'session_changed'};
  if(!location.ok)return {ok:false,reason:location.reason};
  const result=await (deps.put??putImmutable)(location.value,bytes);
  if(!deps.isCurrent())return {ok:false,reason:'session_changed'};
  // A prior attempt may already own the immutable key. The API's checksum HEAD decides.
  if(result.status!==412&&(result.status<200||result.status>=300))return {ok:false,reason:'upload_interrupted'};
  const complete=await deps.api.command('/social/assets/complete',{assetId:checkpoint.assetId,uploadId:checkpoint.uploadId},v=>z.strictObject({version:z.number().int().positive()}).parse(v),{commandId:checkpoint.completionCommandId});
  if(!deps.isCurrent())return {ok:false,reason:'session_changed'};
  if(!complete.ok)return {ok:false,reason:complete.reason};
  checkpoint.version=complete.value.version;await deps.save(checkpoint);
  return deps.isCurrent()?{ok:true,assetId:checkpoint.assetId,version:checkpoint.version}:{ok:false,reason:'session_changed'};
 }catch{return {ok:false,reason:'upload_interrupted'};}
}
async function putImmutable(location:Location,bytes:Buffer):Promise<{status:number}> {
 const url=new URL(location.url);
 if(url.protocol!=='https:'||url.username||url.password||url.port||!/^[-a-z0-9.]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/u.test(url.hostname)||Date.parse(location.expiresAt)<=Date.now())throw new Error('invalid_upload_location');
 const allowed=['content-type','content-length','x-amz-checksum-sha256','x-amz-meta-callie-upload','if-none-match'];
 if(Object.keys(location.headers).some(key=>!allowed.includes(key))||location.headers['if-none-match']!=='*'||location.headers['content-length']!==String(bytes.length)||location.headers['x-amz-checksum-sha256']!==createHash('sha256').update(bytes).digest('base64'))throw new Error('invalid_upload_headers');
 const response=await fetch(url,{method:'PUT',headers:location.headers,body:new Uint8Array(bytes),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(60_000)});
 await response.body?.cancel();
 return {status:response.status};
}
