import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {expect,it} from 'vitest';
import {withSocialImages} from '../src/main/social/materializeImages.ts';
const location={url:'https://bucket.s3.us-east-1.amazonaws.com/image',expiresAt:'2099-01-01T00:00:00Z'};
it('materializes exact approved bytes privately and removes them even when staging fails',async()=>{
 const root=await mkdtemp(join(tmpdir(),'social-materialize-test-'));
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).png().toBuffer();
 const image={assetId:'asset',version:2,sha256:createHash('sha256').update(bytes).digest('hex'),altText:'White square',bytes:bytes.length,location};
 try{
 await expect(withSocialImages([image],{root,current:()=>true,send:async()=>new Response(new Uint8Array(bytes))},async(images)=>{
  expect(await readFile(images[0]!.localPath)).toEqual(bytes);
  expect((await stat(images[0]!.localPath)).mode&0o777).toBe(0o600);
  expect(images[0]!.version).toBe(2);throw new Error('stage_failed');
 })).rejects.toThrow('stage_failed');
 expect(await readdir(root)).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('refuses changed bytes and sign-out before handing files to the browser',async()=>{
 const root=await mkdtemp(join(tmpdir(),'social-materialize-test-'));let staged=false;
 const image={assetId:'asset',version:1,sha256:'a'.repeat(64),altText:'test',bytes:3,location};
 try{
 await expect(withSocialImages([image],{root,current:()=>true,send:async()=>new Response('bad')},async()=>{staged=true;})).rejects.toThrow('image_checksum_mismatch');
 await expect(withSocialImages([image],{root,current:()=>false},async()=>{staged=true;})).rejects.toThrow('session_changed');
 expect(staged).toBe(false);expect(await readdir(root)).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('drops a download completed after sign-out without staging or leaving files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'social-materialize-test-'));let current=true,staged=false;
 const bytes=Buffer.from('download');
 const image={assetId:'asset',version:1,sha256:createHash('sha256').update(bytes).digest('hex'),altText:'test',bytes:bytes.length,location};
 try{
 await expect(withSocialImages([image],{root,current:()=>current,send:async()=>{current=false;return new Response(bytes);}},async()=>{staged=true;})).rejects.toThrow('session_changed');
 expect(staged).toBe(false);expect(await readdir(root)).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
