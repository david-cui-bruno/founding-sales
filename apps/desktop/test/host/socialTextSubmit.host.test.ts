import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {it,expect} from 'vitest';
import {HOST_TESTS_ENABLED,DESKTOP_ROOT} from './support/hostGate.ts';
it.skipIf(!HOST_TESTS_ENABLED)('stages text and attempts one final click in hidden Electron without external requests',async()=>{
 const root=await mkdtemp(join(tmpdir(),'callie-social-submit-'));
 try{
  const script=join(root,'probe.mjs');
  await build({entryPoints:[join(DESKTOP_ROOT,'test/host/support/socialTextSubmitProbe.ts')],outfile:script,bundle:true,platform:'node',format:'esm',external:['electron'],target:'node24'});
  const env:NodeJS.ProcessEnv={...process.env,FSS_SOCIAL_PROBE_DATA:join(root,'data')};delete env['ELECTRON_RUN_AS_NODE'];
  const {stdout}=await promisify(execFile)(createRequire(import.meta.url)('electron') as string,[script],{env,timeout:45_000,maxBuffer:1024*1024});
  const line=stdout.split('\n').find(x=>x.startsWith('SOCIAL_SUBMIT_PROBE:'));expect(line).toBeDefined();
  expect(JSON.parse(line!.slice('SOCIAL_SUBMIT_PROBE:'.length))).toEqual({result:{stage:{ready:true},first:{attempted:true},second:{attempted:false},clicks:1,visible:false,focused:false},shown:0,remaining:0});
 }finally{await rm(root,{recursive:true,force:true});}
},60_000);
