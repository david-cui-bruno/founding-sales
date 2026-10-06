import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import type {ApprovedPost} from './adapters.ts';
import {fetchSocialImageBytes} from './imageThumbnail.ts';
type Image=Omit<ApprovedPost['images'][number],'localPath'>&{bytes:number;location:{url:string;expiresAt:string}};
/** Main-only, bounded delivery scope. Paths never leave the native adapter callback. */
export async function withSocialImages<T>(images:Image[],port:{root:string;current():boolean;send?:typeof fetch},use:(images:ApprovedPost['images'])=>Promise<T>):Promise<T> {
 const check=()=>{if(!port.current())throw new Error('session_changed');};
 check();if(images.length>20)throw new Error('too_many_images');
 const snapshot=images.map(image=>({...image,location:{...image.location}}));
 await mkdir(port.root,{recursive:true,mode:0o700});check();
 const directory=await mkdtemp(join(port.root,'delivery-'));
 try{
  const files:ApprovedPost['images']=[];
  for(const [index,image] of snapshot.entries()){
   check();const bytes=await fetchSocialImageBytes(image.location,image,port.send);check();
   const metadata=await sharp(bytes,{limitInputPixels:4096*4096,failOn:'warning'}).metadata();
   if(!['png','jpeg'].includes(metadata.format??'')||(metadata.pages??1)!==1||!metadata.width||!metadata.height||metadata.width>4096||metadata.height>4096||metadata.exif||metadata.xmp||metadata.iptc)throw new Error('unsupported_image');
   const localPath=join(directory,`image-${index+1}.${metadata.format==='png'?'png':'jpg'}`);
   await writeFile(localPath,bytes,{flag:'wx',mode:0o600});check();
   files.push({assetId:image.assetId,version:image.version,sha256:image.sha256,altText:image.altText,localPath});
  }
  check();return await use(files);
 }finally{await rm(directory,{recursive:true,force:true});}
}
