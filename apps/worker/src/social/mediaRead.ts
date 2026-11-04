import {Readable} from 'node:stream';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';

/** Keys come only from current owner-scoped approved-media rows, never a job payload or URL. */
export function socialImageReader(environment:NodeJS.ProcessEnv):(objectKey:string)=>Promise<Uint8Array>{
 const bucket=environment['FSS_SOCIAL_ASSETS_BUCKET'],region=environment['AWS_REGION'];
 const client=bucket&&region?new S3Client({region,maxAttempts:2}):null;
 return async objectKey=>{
  if(!client||!bucket)throw new Error('social_media_not_configured');
  let body:Readable|undefined;
  try{
   const object=await client.send(new GetObjectCommand({Bucket:bucket,Key:objectKey}),{abortSignal:AbortSignal.timeout(5000)});
   if(!(object.Body instanceof Readable))throw new Error('social_image_unavailable');
   body=object.Body;
   const length=object.ContentLength;
   if(length===undefined||!Number.isSafeInteger(length)||length<=0||length>5*1024*1024||!['image/jpeg','image/png'].includes(object.ContentType??'')||object.ContentEncoding)throw new Error('social_image_unavailable');
   const bytes=Buffer.allocUnsafe(length);let offset=0;
   for await(const chunk of body){
    if(!(chunk instanceof Uint8Array)||offset+chunk.byteLength>length)throw new Error('social_image_unavailable');
    bytes.set(chunk,offset);offset+=chunk.byteLength;
   }
   if(offset!==length)throw new Error('social_image_unavailable');
   return bytes;
  }catch{body?.destroy();throw new Error('social_image_unavailable');}
 };
}
