import {createHash} from 'node:crypto';
import sharp,{type Sharp} from 'sharp';
import {createRequire} from 'node:module';
import {isBoundedStillWebp} from './webpStillHeader.ts';
const require=createRequire(import.meta.url);
const MAX_PIXELS=36_000_000,MAX_INPUT=20*1024*1024,MAX_OUTPUT=5*1024*1024;
export interface SanitizedSocialImage {body:Buffer;sha256:string;bytes:number;mime:'image/jpeg'|'image/png';width:number;height:number}
export class InvalidSocialImage extends Error {constructor(){super('invalid_image');}}
function dimensions(width:number|undefined,height:number|undefined){if(!width||!height||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width*height>MAX_PIXELS)throw new InvalidSocialImage();}
function actualMime(b:Buffer):string|null {
 if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
 if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return 'image/webp';
 if(b.toString('ascii',4,8)==='ftyp'&&['heic','heix','mif1'].includes(b.toString('ascii',8,12)))return 'image/heic';
 return null;
}
type HeicImage={width:number;height:number;decode():Promise<{width:number;height:number;data:Uint8ClampedArray}>};
type HeicImages=HeicImage[]&{dispose():void};
/** Header inspection precedes pixel allocation; libheif display applies HEIF orientation transforms. */
function inspectHeifHeaders(body:Buffer,start=0,end=body.length,depth=0):void{
 if(depth>8)throw new InvalidSocialImage();
 for(let offset=start;offset<end;){
  if(end-offset<8)throw new InvalidSocialImage();
  const size=body.readUInt32BE(offset),type=body.toString('ascii',offset+4,offset+8),length=size===0?end-offset:size;
  if(length<8||length>end-offset||type==='moov')throw new InvalidSocialImage();
  if(type==='ispe'){if(length<20)throw new InvalidSocialImage();dimensions(body.readUInt32BE(offset+12),body.readUInt32BE(offset+16));}
  if(['meta','iprp','ipco'].includes(type))inspectHeifHeaders(body,offset+8+(type==='meta'?4:0),offset+length,depth+1);
  offset+=length;
 }
}
export async function sanitizeSocialImage(body:Buffer,declared:{mime:string;bytes:number;sha256:string}):Promise<SanitizedSocialImage>{
 try {
  if(body.length===0||body.length>MAX_INPUT||body.length!==declared.bytes||createHash('sha256').update(body).digest('hex')!==declared.sha256||actualMime(body)!==declared.mime)throw new InvalidSocialImage();
  if(declared.mime==='image/webp'&&!isBoundedStillWebp(body))throw new InvalidSocialImage();
  if(declared.mime==='image/png'){
   for(let offset=8;offset+12<=body.length;){
    const length=body.readUInt32BE(offset),type=body.toString('ascii',offset+4,offset+8);
    if(length>body.length-offset-12||type==='acTL')throw new InvalidSocialImage();
    offset+=length+12;
   }
  }
  let image:Sharp;
  if(declared.mime==='image/heic'){
   inspectHeifHeaders(body);
   const decoder=require('heic-decode') as {all(input:{buffer:Buffer}):Promise<HeicImages>};
   const images=await decoder.all({buffer:body});
   try{if(images.length!==1)throw new InvalidSocialImage();const source=images[0]!;dimensions(source.width,source.height);const decoded=await source.decode();dimensions(decoded.width,decoded.height);image=sharp(Buffer.from(decoded.data.buffer,decoded.data.byteOffset,decoded.data.byteLength),{raw:{width:decoded.width,height:decoded.height,channels:4}});}finally{images.dispose();}
  }else{
   image=sharp(body,{limitInputPixels:MAX_PIXELS,animated:false,failOn:'warning'});
   const meta=await image.metadata();dimensions(meta.width,meta.height);if((meta.pages??1)!==1||meta.pageHeight&&meta.pageHeight!==meta.height)throw new InvalidSocialImage();
  }
  // No withMetadata/keepMetadata: sharp strips EXIF, XMP, ICC and GPS by default.
  let result=await image.rotate().resize({width:4096,height:4096,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:85,mozjpeg:true}).toBuffer({resolveWithObject:true});
  if(result.data.length>MAX_OUTPUT)result=await sharp(result.data).resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).jpeg({quality:80,mozjpeg:true}).toBuffer({resolveWithObject:true});
  if(result.data.length>MAX_OUTPUT||result.info.width>4096||result.info.height>4096)throw new InvalidSocialImage();
  return {body:result.data,bytes:result.data.length,sha256:createHash('sha256').update(result.data).digest('hex'),mime:'image/jpeg',width:result.info.width,height:result.info.height};
 }catch{throw new InvalidSocialImage();}
}
