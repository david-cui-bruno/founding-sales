import {createHash} from 'node:crypto';
import sharp from 'sharp';
/** Main-process only. Callers fetch a ready derivative and pass its recorded digest. */
export async function socialImageThumbnail(bytes:Buffer,expectedSha256:string):Promise<string> {
 if(bytes.length>5*1024*1024)throw new Error('image_too_large');
 if(!/^[a-f0-9]{64}$/u.test(expectedSha256)||createHash('sha256').update(bytes).digest('hex')!==expectedSha256)throw new Error('image_checksum_mismatch');
 const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(!png&&!jpeg)throw new Error('unsupported_image');
 const options={limitInputPixels:4096*4096,failOn:'warning' as const};
 const metadata=await sharp(bytes,options).metadata();
 if((metadata.pages??1)!==1)throw new Error('unsupported_image');
 const output=await sharp(bytes,options).autoOrient().resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).png().timeout({seconds:10}).toBuffer();
 if(output.length>512*1024)throw new Error('preview_too_large');
 return `data:image/png;base64,${output.toString('base64')}`;
}

let thumbnailTail:Promise<unknown>=Promise.resolve();
let thumbnailPending=0;
export function fetchSocialThumbnail(location:{url:string;expiresAt:string},image:{sha256:string;bytes:number},send:typeof fetch=fetch):Promise<string> {
 if(thumbnailPending>=32)return Promise.reject(new Error('preview_busy'));
 thumbnailPending++;
 const task=thumbnailTail.then(()=>fetchThumbnail(location,image,send)).finally(()=>{thumbnailPending--;});
 thumbnailTail=task.catch(()=>{});
 return task;
}
async function fetchThumbnail(location:{url:string;expiresAt:string},image:{sha256:string;bytes:number},send:typeof fetch=fetch):Promise<string> {
 const url=new URL(location.url);
 const expiry=Date.parse(location.expiresAt);
 if(url.protocol!=='https:'||url.username||url.password||url.port||!/^[-a-z0-9.]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/u.test(url.hostname)||!Number.isFinite(expiry)||expiry<=Date.now())throw new Error('invalid_image_location');
 if(!Number.isSafeInteger(image.bytes)||image.bytes<=0||image.bytes>5*1024*1024)throw new Error('image_too_large');
 const response=await send(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(15_000)});
 if(!response.ok||!response.body)throw new Error('image_unavailable');
 const chunks:Uint8Array[]=[];let total=0;
 const reader=response.body.getReader();
 try{while(true){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;if(total>image.bytes)throw new Error('image_size_mismatch');chunks.push(item.value);}}
 finally{await reader.cancel().catch(()=>{});}
 if(total!==image.bytes)throw new Error('image_size_mismatch');
 return socialImageThumbnail(Buffer.concat(chunks),image.sha256);
}
