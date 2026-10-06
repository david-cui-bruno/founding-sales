import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {expect,it} from 'vitest';
import {socialImageThumbnail} from '../src/main/social/imageThumbnail.ts';
it('makes a bounded inline preview only from matching reviewed image bytes',async()=>{
 const bytes=await sharp({create:{width:1000,height:500,channels:4,background:'#334455'}}).png().toBuffer();
 const hash=createHash('sha256').update(bytes).digest('hex');
 const value=await socialImageThumbnail(bytes,hash);
 expect(value.startsWith('data:image/png;base64,')).toBe(true);
 const metadata=await sharp(Buffer.from(value.split(',')[1]!,'base64')).metadata();
 expect(metadata.width).toBe(320);expect(metadata.height).toBe(160);expect(metadata.exif).toBeUndefined();
 await expect(socialImageThumbnail(bytes,'a'.repeat(64))).rejects.toThrow('image_checksum_mismatch');
});
it('refuses corrupt or oversized media before decoding',async()=>{
 const bytes=Buffer.from('<svg onload="alert(1)"></svg>');
 await expect(socialImageThumbnail(bytes,createHash('sha256').update(bytes).digest('hex'))).rejects.toThrow('unsupported_image');
 await expect(socialImageThumbnail(Buffer.alloc(5*1024*1024+1),'a'.repeat(64))).rejects.toThrow('image_too_large');
});
it('does not fetch non-S3 or expired signed URLs',async()=>{
 const {fetchSocialThumbnail}=await import('../src/main/social/imageThumbnail.ts');
 const metadata={sha256:'a'.repeat(64),bytes:100};
 await expect(fetchSocialThumbnail({url:'https://127.0.0.1/private',expiresAt:'2099-01-01T00:00:00Z'},metadata)).rejects.toThrow('invalid_image_location');
 await expect(fetchSocialThumbnail({url:'https://bucket.s3.us-east-1.amazonaws.com/image',expiresAt:'2000-01-01T00:00:00Z'},metadata)).rejects.toThrow('invalid_image_location');
});
it('serializes thumbnail fetch and decoding to bound memory across visible cards',async()=>{
 const {fetchSocialThumbnail}=await import('../src/main/social/imageThumbnail.ts');
 const bytes=await sharp({create:{width:20,height:20,channels:3,background:'white'}}).png().toBuffer();
 let active=0,peak=0;const send:typeof fetch=async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,10));active--;return new Response(new Uint8Array(bytes));};
 const location={url:'https://bucket.s3.us-east-1.amazonaws.com/image',expiresAt:'2099-01-01T00:00:00Z'},metadata={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 await Promise.all([1,2,3].map(()=>fetchSocialThumbnail(location,metadata,send)));expect(peak).toBe(1);
});
