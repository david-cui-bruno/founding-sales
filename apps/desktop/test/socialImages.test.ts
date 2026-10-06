import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {it,expect} from 'vitest';
import {normalizeSocialImage} from '../src/main/social/imageNormalize.ts';
async function run(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'social-image-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
it('keeps the original, applies opaque redaction, strips metadata, and hashes the derivative',async()=>run(async root=>{
 const input=join(root,'in.jpg'),output=join(root,'out.png');
 await sharp({create:{width:40,height:20,channels:3,background:'#ff0000'}}).jpeg().withExif({IFD0:{Artist:'Private name'},IFD3:{GPSLatitudeRef:'N',GPSLatitude:'42/1 1/1 1/1'}}).toFile(input);
 const original=await readFile(input);
 const result=await normalizeSocialImage({inputPath:input,outputPath:output,crop:null,redactions:[{x:0,y:0,width:10,height:10}],lossless:true});
 expect(result).toMatchObject({width:40,height:20,mime:'image/png'});expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);expect(await readFile(input)).toEqual(original);
 const metadata=await sharp(output).metadata();expect(metadata.exif).toBeUndefined();
 const {data,info}=await sharp(output).raw().toBuffer({resolveWithObject:true});expect([...data.subarray(0,3)]).toEqual([0,0,0]);expect(data[15*info.channels]).toBeGreaterThan(240);
}));
for(const orientation of [1,2,3,4,5,6,7,8])it(`normalizes EXIF orientation ${orientation}`,async()=>run(async root=>{
 const input=join(root,'in.jpg'),output=join(root,'out.png');
 await sharp({create:{width:40,height:20,channels:3,background:'#ff0000'}}).jpeg().withMetadata({orientation}).toFile(input);
 const result=await normalizeSocialImage({inputPath:input,outputPath:output,crop:null,redactions:[],lossless:true});
 expect([result.width,result.height]).toEqual(orientation>=5?[20,40]:[40,20]);expect((await sharp(output).metadata()).orientation).toBeUndefined();
}));
it('preserves transparency and rejects invalid crop, SVG, corruption and oversized dimensions',async()=>run(async root=>{
 const input=join(root,'in.png'),output=join(root,'out.png');
 await sharp({create:{width:12,height:10,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toFile(input);
 const args={inputPath:input,outputPath:output,crop:null,redactions:[]};
 await normalizeSocialImage(args);expect((await sharp(output).metadata()).hasAlpha).toBe(true);
 await expect(normalizeSocialImage({...args,crop:{x:-1,y:0,width:5,height:5}})).rejects.toThrow('invalid_crop');
 await writeFile(input,'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');await expect(normalizeSocialImage(args)).rejects.toThrow('unsupported_image');
 await writeFile(input,'not an image');await expect(normalizeSocialImage(args)).rejects.toThrow();
 await sharp({create:{width:8000,height:7000,channels:3,background:'#fff'}}).png().toFile(input);await expect(normalizeSocialImage(args)).rejects.toThrow();
}));
it('mirrors actual pixels rather than only dropping the orientation tag',async()=>run(async root=>{
 const input=join(root,'mirror.jpg'),output=join(root,'out.png');
 const blue=await sharp({create:{width:20,height:20,channels:3,background:'#0000ff'}}).png().toBuffer();
 await sharp({create:{width:40,height:20,channels:3,background:'#ff0000'}}).composite([{input:blue,left:20,top:0}]).jpeg({quality:100}).withMetadata({orientation:2}).toFile(input);
 await normalizeSocialImage({inputPath:input,outputPath:output,crop:null,redactions:[],lossless:true});
 const {data,info}=await sharp(output).raw().toBuffer({resolveWithObject:true});
 const left=(10*40+5)*info.channels,right=(10*40+35)*info.channels;
 expect(data[left+2]).toBeGreaterThan(240);expect(data[left]).toBeLessThan(10);
 expect(data[right]).toBeGreaterThan(240);expect(data[right+2]).toBeLessThan(10);
}));
it.skipIf(process.platform!=='darwin')('converts a HEIC phone-image fixture without replacing its original',async()=>run(async root=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const png=join(root,'source.png'),input=join(root,'phone.heic'),output=join(root,'output.jpg');
 await sharp({create:{width:40,height:20,channels:3,background:'#aabbcc'}}).png().toFile(png);
 await promisify(execFile)('/usr/bin/sips',['-s','format','heic',png,'--out',input],{timeout:30_000});
 const original=await readFile(input);const result=await normalizeSocialImage({inputPath:input,outputPath:output,crop:null,redactions:[]});
 expect(result.width).toBe(40);expect(result.height).toBe(20);expect(await readFile(input)).toEqual(original);expect((await sharp(output).metadata()).exif).toBeUndefined();
}));
const orientationPixels=[[0,1,2,3,4,5],[2,1,0,5,4,3],[5,4,3,2,1,0],[3,4,5,0,1,2],[0,3,1,4,2,5],[3,0,4,1,5,2],[5,2,4,1,3,0],[2,5,1,4,0,3]];
for(let orientation=1;orientation<=8;orientation++)it(`preserves the correct pixel positions for orientation ${orientation}`,async()=>run(async root=>{
 const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,0],[255,0,255],[0,255,255]];
 const input=join(root,'in.png'),output=join(root,'out.png');await sharp(Buffer.from(colors.flat()),{raw:{width:3,height:2,channels:3}}).png().withMetadata({orientation}).toFile(input);
 await normalizeSocialImage({inputPath:input,outputPath:output,crop:null,redactions:[]});const pixels=await sharp(output).removeAlpha().raw().toBuffer();expect([...pixels]).toEqual(orientationPixels[orientation-1]!.flatMap(i=>colors[i]!));
}));
it('refuses animation and lossless output over its limit, and removes appended non-image bytes',async()=>run(async root=>{
 const {randomBytes}=await import('node:crypto');const input=join(root,'in.png'),output=join(root,'out.png');
 const one=await sharp({create:{width:4,height:4,channels:3,background:'#f00'}}).png().toBuffer();const two=await sharp({create:{width:4,height:4,channels:3,background:'#00f'}}).png().toBuffer();
 await sharp([one,two],{join:{animated:true}}).webp().toFile(input);expect((await sharp(input).metadata()).pages).toBe(2);
 await expect(normalizeSocialImage({inputPath:input,outputPath:output,crop:null,redactions:[]})).rejects.toThrow('animated_image_not_supported');
 await sharp(randomBytes(1600*1600*3),{raw:{width:1600,height:1600,channels:3}}).png().toFile(input);
 await expect(normalizeSocialImage({inputPath:input,outputPath:output,crop:null,redactions:[],lossless:true})).rejects.toThrow('image_needs_edit');
 await writeFile(input,Buffer.concat([one,Buffer.from('<script>private marker</script>')]));await normalizeSocialImage({inputPath:input,outputPath:output,crop:null,redactions:[]});expect((await readFile(output)).includes(Buffer.from('private marker'))).toBe(false);
}));
