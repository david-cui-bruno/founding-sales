import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {lstat,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import sharp from 'sharp';
interface Rect{x:number;y:number;width:number;height:number}
interface Input{inputPath:string;outputPath:string;crop:Rect|null;redactions:readonly Rect[];lossless?:boolean}
export interface NormalizedSocialImage{sha256:string;width:number;height:number;mime:'image/png'|'image/jpeg';bytes:number}
const MAX_INPUT=20*1024*1024,MAX_PIXELS=48_000_000,MAX_OUTPUT=5*1024*1024;
let tail:Promise<unknown>=Promise.resolve();
/** One bounded decode at a time. Paths are main-process file-picker/private asset paths. */
export function normalizeSocialImage(input:Input):Promise<NormalizedSocialImage>{
 const task=tail.then(()=>normalize(input));tail=task.catch(()=>{});return task;
}
function validRect(r:Rect,w:number,h:number){return [r.x,r.y,r.width,r.height].every(Number.isSafeInteger)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=w&&r.y+r.height<=h;}
async function normalize(input:Input):Promise<NormalizedSocialImage>{
 if(!isAbsolute(input.inputPath)||!isAbsolute(input.outputPath)||resolve(input.inputPath)===resolve(input.outputPath))throw new Error('invalid_image_path');
 const stat=await lstat(input.inputPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_INPUT)throw new Error('image_too_large_or_invalid');
 let bytes=await readFile(input.inputPath);if(bytes.length>MAX_INPUT)throw new Error('image_too_large');
 const heic=bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp'&&['heic','heix','mif1'].includes(bytes.toString('ascii',8,12));
 let temporary:string|null=null;
 try{
  if(heic){
   if(process.platform!=='darwin')throw new Error('heic_requires_mac');
   const dimensions=await promisify(execFile)('/usr/bin/sips',['-g','pixelWidth','-g','pixelHeight',input.inputPath],{timeout:30_000,maxBuffer:8192});
   const width=Number(/pixelWidth:\s*(\d+)/u.exec(dimensions.stdout)?.[1]),height=Number(/pixelHeight:\s*(\d+)/u.exec(dimensions.stdout)?.[1]);
   if(!width||!height||width*height>MAX_PIXELS)throw new Error('image_too_large');
   temporary=await mkdtemp(join(tmpdir(),'callie-image-'));const converted=join(temporary,'converted.png');
   await promisify(execFile)('/usr/bin/sips',['-s','format','png',input.inputPath,'--out',converted],{timeout:30_000,maxBuffer:8192});
   bytes=await readFile(converted);
  }
  const opts={limitInputPixels:MAX_PIXELS,failOn:'warning' as const};
  const metadata=await sharp(bytes,opts).metadata();
  if(!['png','jpeg','webp'].includes(metadata.format??''))throw new Error('unsupported_image');
  if((metadata.pages??1)>1)throw new Error('animated_image_not_supported');
  const oriented=await sharp(bytes,opts).autoOrient().png().timeout({seconds:30}).toBuffer({resolveWithObject:true});
  let width=oriented.info.width,height=oriented.info.height;
  if(input.crop&&!validRect(input.crop,width,height))throw new Error('invalid_crop');
  let image=sharp(oriented.data,opts);
  if(input.crop){image=image.extract({left:input.crop.x,top:input.crop.y,width:input.crop.width,height:input.crop.height});width=input.crop.width;height=input.crop.height;}
  if(input.redactions.length>100||input.redactions.some(r=>!validRect(r,width,height)))throw new Error('invalid_redaction');
  // Composite before downscaling, so redaction coordinates are the displayed crop's pixels.
  if(input.redactions.length){
   const base=await image.png().timeout({seconds:30}).toBuffer();
   image=sharp(base,opts).composite(input.redactions.map(r=>({input:{create:{width:r.width,height:r.height,channels:4 as const,background:{r:0,g:0,b:0,alpha:1}}},left:r.x,top:r.y,blend:'over' as const})));
   image=sharp(await image.png().timeout({seconds:30}).toBuffer(),opts);
  }
  image=image.resize({width:4096,height:4096,fit:'inside',withoutEnlargement:true});
  const png=input.lossless===true||metadata.hasAlpha||metadata.format==='png';
  const output=await (png?image.png():image.jpeg({quality:90})).timeout({seconds:30}).toBuffer({resolveWithObject:true});
  if(output.data.length>MAX_OUTPUT)throw new Error('image_needs_edit');
  await writeFile(input.outputPath,output.data,{flag:'wx',mode:0o600});
  return {sha256:createHash('sha256').update(output.data).digest('hex'),width:output.info.width,height:output.info.height,mime:png?'image/png':'image/jpeg',bytes:output.data.length};
 }finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
}
