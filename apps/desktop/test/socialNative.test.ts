import type sharpType from 'sharp';
import {it,expect} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createRequire} from 'node:module';
import {copySocialImageRuntime} from '../scripts/socialNative.ts';
it('stages only sharp and its runtime dependencies and decodes with the staged native module',async()=>{
 const root=await mkdtemp(join(tmpdir(),'social-native-'));try{
 const names=await copySocialImageRuntime(root);expect(names).toContain('sharp');expect(names).not.toContain('electron');expect(names.length).toBeLessThan(10);
 const manifest=JSON.parse(await readFile(join(root,'node_modules/sharp/package.json'),'utf8')) as {version:string};expect(manifest.version).toBe('0.35.5');
 const require=createRequire(join(root,'probe.cjs'));const sharp=require('sharp') as typeof sharpType;
 const r=await sharp({create:{width:10,height:20,channels:3,background:'#fff'}}).png().toBuffer({resolveWithObject:true});expect(r.info.width).toBe(10);expect(r.info.height).toBe(20);
 }finally{await rm(root,{recursive:true,force:true});}
});
