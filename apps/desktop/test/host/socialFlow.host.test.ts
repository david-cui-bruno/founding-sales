import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {it,expect} from 'vitest';
import {HOST_TESTS_ENABLED,DESKTOP_ROOT} from './support/hostGate.ts';
it.skipIf(!HOST_TESTS_ENABLED).each(['none','lost','changed'])('runs full hidden adapter submit/restart/cancel flow: %s',async(fault)=>{
 const root=await mkdtemp(join(tmpdir(),'callie-social-submit-'));
 try{
  const script=join(root,'probe.mjs');
  await build({entryPoints:[join(DESKTOP_ROOT,'test/host/support/socialFlowProbe.ts')],outfile:script,bundle:true,platform:'node',format:'esm',external:['electron'],target:'node24'});
  const env:NodeJS.ProcessEnv={...process.env,FSS_SOCIAL_PROBE_DATA:join(root,'data'),FSS_SOCIAL_FAULT:fault};delete env['ELECTRON_RUN_AS_NODE'];
  const {stdout}=await promisify(execFile)(createRequire(import.meta.url)('electron') as string,[script],{env,timeout:45_000,maxBuffer:1024*1024});
  const line=stdout.split('\n').find(x=>x.startsWith('SOCIAL_FLOW_PROBE:'));expect(line).toBeDefined();
  const output=JSON.parse(line!.slice('SOCIAL_FLOW_PROBE:'.length));
  expect(output).toMatchObject({first:{visible:false,focused:false,result:{state:fault==='changed'?'unknown':'scheduled'}},second:{visible:false,focused:false,result:{state:fault==='changed'?'unknown':'cancelled'},counts:{submits:1,deletes:fault==='changed'?0:1}},lostResponses:fault==='lost'?1:0,shown:0,remaining:0});
  if(fault!=='changed')expect(output.observed).toMatchObject({state:'scheduled',complete:true,receiptId:'urn:li:share:123'});
 }finally{await rm(root,{recursive:true,force:true});}
},60_000);
