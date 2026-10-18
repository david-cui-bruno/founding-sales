import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {it,expect} from 'vitest';
import {HOST_TESTS_ENABLED,DESKTOP_ROOT} from './support/hostGate.ts';
it.skipIf(!HOST_TESTS_ENABLED).each(['none','alt','text','extra_image'])('checks combined image staging in hidden Electron: %s',async(fault)=>{
 const root=await mkdtemp(join(tmpdir(),'callie-social-probe-'));
 try{
  const script=join(root,'probe.mjs');const image=join(root,'image.png');const bytes=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).png().toBuffer();await writeFile(image,bytes);
  await build({entryPoints:[join(DESKTOP_ROOT,'test/host/support/socialImageStageProbe.ts')],outfile:script,bundle:true,platform:'node',format:'esm',external:['electron'],plugins:[{name:'sharp-host',setup(builder){builder.onResolve({filter:/^sharp$/},()=>({path:createRequire(import.meta.url).resolve('sharp'),external:true}));}}],target:'node24'});
  const electron=createRequire(import.meta.url)('electron') as string;
  const env:NodeJS.ProcessEnv={...process.env,FSS_SOCIAL_PROBE_DATA:join(root,'data'),FSS_SOCIAL_FAULT:fault,FSS_SOCIAL_IMAGE:image,FSS_SOCIAL_ROOT:root,FSS_SOCIAL_HASH:createHash('sha256').update(bytes).digest('hex')};delete env['ELECTRON_RUN_AS_NODE'];
  const {stdout}=await promisify(execFile)(electron,[script],{env,timeout:45_000,maxBuffer:1024*1024});
  const line=stdout.split('\n').find(x=>x.startsWith('SOCIAL_IMAGE_PROBE:'));expect(line).toBeDefined();
  const output=JSON.parse(line!.slice('SOCIAL_IMAGE_PROBE:'.length));
  expect(output).toMatchObject({result:{visible:false,focused:false},shown:0,remaining:0});
  if(fault==='none')expect(output.result).toMatchObject({stage:{ready:true},preview:{text:'Approved image post',alt:'Synthetic image',loaded:true,dialogs:1},proof:{ok:true,view:{sha256:createHash('sha256').update(bytes).digest('hex'),altText:'Synthetic image',bytes:bytes.length}}});
  else expect(output.result.stage).toEqual({ready:false,reason:fault==='text'?'staged_content_changed':'image_completion_unverified'});
 }finally{await rm(root,{recursive:true,force:true});}
},60_000);
