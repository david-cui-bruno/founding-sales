import {linkedInImageInputScript} from './linkedinImageDom.ts';
import {createHash} from 'node:crypto';import {constants} from 'node:fs';import {open,realpath} from 'node:fs/promises';import {relative,isAbsolute,sep} from 'node:path';import sharp from 'sharp';
interface Ports {root:string;current():boolean;contents:{getURL():string;executeJavaScriptInIsolatedWorld(world:number,scripts:{code:string}[],gesture?:boolean):Promise<unknown>}}
/** Pass only reviewed derivatives materialized in this delivery's private directory.
 * This hands files to the native editor; it does NOT prove successful upload or approval.
 */
export async function stageLinkedInImages(images:readonly {localPath:string;sha256:string}[],port:Ports):Promise<{ready:boolean;reason?:string}>{
 const current=()=>port.current()&&port.contents.getURL()==='https://www.linkedin.com/sharing/compose';
 try{
  if(!current())return {ready:false,reason:'session_changed'};
  if(images.length<1||images.length>20)return {ready:false,reason:'invalid_image_count'};
  const root=await realpath(port.root),files:{name:string;mime:string;base64:string}[]=[];
  for(const image of images){
   if(!current())return {ready:false,reason:'session_changed'};
   const path=await realpath(image.localPath),rel=relative(root,path);if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('outside_directory');
   const handle=await open(image.localPath,constants.O_RDONLY|constants.O_NOFOLLOW);
   let bytes:Buffer;
   try{const stat=await handle.stat();if(!stat.isFile()||stat.size<1||stat.size>5*1024*1024)throw new Error('image_size');const buffer=Buffer.alloc(stat.size+1);const read=await handle.read(buffer,0,buffer.length,0);if(read.bytesRead!==stat.size)throw new Error('image_changed');bytes=buffer.subarray(0,stat.size);}finally{await handle.close();}
   if(!/^[a-f0-9]{64}$/.test(image.sha256)||createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw new Error('image_changed');
   const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;if(!png&&!jpeg)throw new Error('image_format');
   const metadata=await sharp(bytes,{limitInputPixels:4096*4096,failOn:'warning'}).metadata();if(!metadata.width||!metadata.height||metadata.width>4096||metadata.height>4096||(metadata.pages??1)!==1||metadata.exif||metadata.xmp||metadata.iptc)throw new Error('image_metadata');
   files.push({name:`image-${files.length+1}.${png?'png':'jpg'}`,mime:png?'image/png':'image/jpeg',base64:bytes.toString('base64')});
  }
  if(!current())return {ready:false,reason:'session_changed'};
  const code=linkedInImageInputScript(files);
  const answer=await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code}],false);
  if(!current())return {ready:false,reason:'session_changed'};
  const a=answer as {ok?:unknown;count?:unknown}|null;
  return a?.ok===true&&a.count===files.length?{ready:true}:{ready:false,reason:'media_input_unavailable'};
 }catch{return {ready:false,reason:'image_handoff_failed'};}
}
