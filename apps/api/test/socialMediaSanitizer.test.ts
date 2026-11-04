import {it,expect} from 'vitest';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {sanitizeSocialImage} from '../src/social/sanitizeMedia.ts';
const declared=(body:Buffer,mime:string)=>({mime,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
for(const [format,mime] of [['jpeg','image/jpeg'],['png','image/png'],['webp','image/webp']] as const){
 it(`normalizes actual ${format} bytes and strips all private metadata`,async()=>{
  const body=await sharp({create:{width:80,height:40,channels:3,background:'#4287f5'}}).withMetadata({orientation:6,exif:{IFD0:{Artist:'synthetic-private-marker'},IFD3:{GPSLatitudeRef:'N',GPSLatitude:'40/1 0/1 0/1'}}}).toFormat(format).toBuffer();
  const result=await sanitizeSocialImage(body,declared(body,mime));
  expect(result.bytes).toBeLessThanOrEqual(5*1024*1024);expect(result.sha256).toBe(createHash('sha256').update(result.body).digest('hex'));
  const meta=await sharp(result.body).metadata();expect(meta.format).toBe('jpeg');expect(meta.exif).toBeUndefined();expect(meta.xmp).toBeUndefined();expect(meta.icc).toBeUndefined();expect(meta.orientation).toBeUndefined();expect(result.body.includes(Buffer.from('synthetic-private-marker'))).toBe(false);
  if(format==='jpeg')expect({width:result.width,height:result.height}).toEqual({width:40,height:80});
 });
}
it('rejects fake MIME, checksum, length and malformed content rather than trusting HEAD',async()=>{
 const body=await sharp({create:{width:4,height:4,channels:3,background:'white'}}).png().toBuffer();
 await expect(sanitizeSocialImage(body,declared(body,'image/jpeg'))).rejects.toThrow('invalid_image');
 await expect(sanitizeSocialImage(body,{...declared(body,'image/png'),sha256:'a'.repeat(64)})).rejects.toThrow('invalid_image');
 await expect(sanitizeSocialImage(body,{...declared(body,'image/png'),bytes:body.length+1})).rejects.toThrow('invalid_image');
 const malformed=Buffer.from([255,216,255,0,0]);await expect(sanitizeSocialImage(malformed,declared(malformed,'image/jpeg'))).rejects.toThrow('invalid_image');
});
it('rejects encoded bytes and header dimensions above hard bounds',async()=>{
 const huge=Buffer.alloc(20*1024*1024+1);await expect(sanitizeSocialImage(huge,declared(huge,'image/jpeg'))).rejects.toThrow('invalid_image');
 const body=await sharp({create:{width:6001,height:6000,channels:3,background:'white'}}).png().toBuffer();await expect(sanitizeSocialImage(body,declared(body,'image/png'))).rejects.toThrow('invalid_image');
});
it('rejects animated PNG control chunks before pixel normalization',async()=>{
 const still=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer();
 const animation=Buffer.alloc(20);animation.writeUInt32BE(8);animation.write('acTL',4);animation.writeUInt32BE(2,8);
 const body=Buffer.concat([still.subarray(0,33),animation,still.subarray(33)]);
 await expect(sanitizeSocialImage(body,declared(body,'image/png'))).rejects.toThrow('invalid_image');
});
it('decodes a real HEVC still through libheif and emits metadata-free JPEG',async()=>{
 // Synthetic rainbow fixture, libheif LGPL-3.0 tests/data/rainbow-451x461.heic:
 // https://github.com/strukturag/libheif/blob/master/tests/data/rainbow-451x461.heic
 const body=await readFile(new URL('./fixtures/social-rainbow.heic',import.meta.url));
 const result=await sanitizeSocialImage(body,declared(body,'image/heic'));
 expect({width:result.width,height:result.height}).toEqual({width:451,height:461});
 const meta=await sharp(result.body).metadata();expect(meta.format).toBe('jpeg');expect(meta.exif).toBeUndefined();expect(meta.orientation).toBeUndefined();
});
it('applies HEIF irot before stripping transformation metadata',async()=>{
 const body=await readFile(new URL('./fixtures/social-rainbow.heic',import.meta.url));
 // Replace optional color property #2 in place, then associate the rotation
 // AFTER the clean-aperture crop. HEIF transformations follow association order.
 const color=body.indexOf(Buffer.from('colr'));expect(color).toBeGreaterThan(4);
 const length=body.readUInt32BE(color-4);expect(length).toBeGreaterThanOrEqual(9);
 body.write('irot',color);body.fill(0,color+4,color-4+length);body[color+4]=1;
 const associations=body.indexOf(Buffer.from('ipma'));expect(associations).toBeGreaterThan(4);
 const count=body[associations+14]!;expect(count).toBe(5);
 const properties=[...body.subarray(associations+15,associations+15+count)];
 expect(properties).toContain(2);
 Buffer.from([...properties.filter(value=>(value&127)!==2),0x82]).copy(body,associations+15);
 const result=await sanitizeSocialImage(body,declared(body,'image/heic'));
 expect({width:result.width,height:result.height}).toEqual({width:461,height:451});
 expect((await sharp(result.body).metadata()).orientation).toBeUndefined();
});
it('rejects actual animated WebP rather than normalizing only its first frame',async()=>{
 const header='47494638396101000100800000000000ffffff';
 const frame='21f904000a0000002c0000000001000100000202440100';
 // Distinct black/white frames: identical frames are coalesced by libwebp.
 const whiteFrame='21f904000a0000002c00000000010001000002024c0100';
 const gif=Buffer.from(`${header}${frame}${whiteFrame}3b`,'hex');
 const body=await sharp(gif,{animated:true}).webp().toBuffer();
 expect((await sharp(body,{animated:true}).metadata()).pages).toBe(2);
 await expect(sanitizeSocialImage(body,declared(body,'image/webp'))).rejects.toThrow('invalid_image');
});
