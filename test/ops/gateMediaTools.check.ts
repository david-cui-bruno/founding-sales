import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {repositoryPath} from './support/repository.ts';

const workflow=readFileSync(repositoryPath('.github/workflows/greenfield.yml'),'utf8');
const setup=workflow.split('      - name: Meeting media test tools\n')[1]?.split('      - name: Greenfield gate')[0];
if(!setup)throw new Error('Missing media setup step');
const body=setup.split('        run: |\n')[1]?.split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
if(!body)throw new Error('Missing media setup script');

it('uses installed media tools without invoking package installation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fss-media-tools-'));
 try{
  for(const name of ['ffmpeg','ffprobe'])writeFileSync(join(dir,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
  writeFileSync(join(dir,'sudo'),'#!/bin/sh\necho unexpected-install >&2\nexit 99\n',{mode:0o755});
  const run=spawnSync('bash',['-c',body],{encoding:'utf8',env:{...process.env,PATH:`${dir}:/usr/bin:/bin`,RUNNER_TEMP:dir}});
  expect(run.status,run.stderr).toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('fails visibly when bounded package setup fails, before the test gate',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fss-media-tools-'));
 try{
  writeFileSync(join(dir,'sudo'),'#!/bin/sh\nprintf "%s\\n" "$*"\nexit 124\n',{mode:0o755});
  const absent='command(){ if [ "$1" = -v ]; then return 1; fi; builtin command "$@"; }\n';
  const run=spawnSync('bash',['-c',absent+body],{encoding:'utf8',env:{...process.env,PATH:`${dir}:/usr/bin:/bin`,RUNNER_TEMP:dir}});
  expect(run.status).toBe(124);
  expect(run.stdout).toContain('timeout --kill-after=10s 90s');
  expect(run.stdout).toContain('the test gate has not run');
  expect(setup).toContain('timeout-minutes: 4');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
