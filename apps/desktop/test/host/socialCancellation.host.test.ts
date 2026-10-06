import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {it,expect} from 'vitest';
import {HOST_TESTS_ENABLED,DESKTOP_ROOT} from './support/hostGate.ts';
it.skipIf(!HOST_TESTS_ENABLED).each(['none','partial','changed'])('checks guarded cancellation in hidden Electron: %s',async(fault)=>{
 const root=await mkdtemp(join(tmpdir(),'callie-social-probe-'));
 try{
  const script=join(root,'probe.mjs');
  await build({entryPoints:[join(DESKTOP_ROOT,'test/host/support/socialCancellationProbe.ts')],outfile:script,bundle:true,platform:'node',format:'esm',external:['electron'],target:'node24'});
  const electron=createRequire(import.meta.url)('electron') as string;
  const env:NodeJS.ProcessEnv={...process.env,FSS_SOCIAL_PROBE_DATA:join(root,'data'),FSS_SOCIAL_FAULT:fault};delete env['ELECTRON_RUN_AS_NODE'];
  const {stdout}=await promisify(execFile)(electron,[script],{env,timeout:45_000,maxBuffer:1024*1024});
  const line=stdout.split('\n').find(x=>x.startsWith('SOCIAL_CANCEL_PROBE:'));expect(line).toBeDefined();
  const output=JSON.parse(line!.slice('SOCIAL_CANCEL_PROBE:'.length));
  expect(output).toMatchObject({result:{visible:false,focused:false},shown:0,remaining:0});
  expect(output.result).toMatchObject({cancelled:{state:fault==='none'?'cancelled':'unknown'},confirms:fault==='changed'?0:1});
 }finally{await rm(root,{recursive:true,force:true});}
},60_000);
