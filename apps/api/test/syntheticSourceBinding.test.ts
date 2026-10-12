import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {snapshotSyntheticAcceptanceSource,claimSharedSyntheticAcceptanceDirectory} from './support/syntheticSourceBinding.ts';
it('binds actual tracked application, schema and dependency files while ignoring result artifacts',()=>{
 const root=mkdtempSync(join(tmpdir(),'synthetic-source-'));
 try{
  execFileSync('git',['init','-q',root]);mkdirSync(join(root,'packages'),{recursive:true});mkdirSync(join(root,'.context'));
  writeFileSync(join(root,'packages','source.ts'),'original');writeFileSync(join(root,'package-lock.json'),'lock');
  execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture'],{cwd:root});
  const frozen=snapshotSyntheticAcceptanceSource(root);writeFileSync(join(root,'.context','result.json'),'private output');
  expect(snapshotSyntheticAcceptanceSource(root)).toEqual(frozen);
  writeFileSync(join(root,'packages','source.ts'),'changed');expect(snapshotSyntheticAcceptanceSource(root).sha256).not.toBe(frozen.sha256);
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('claims a paid scope once across different checkouts before any dispatch',()=>{
 const root=mkdtempSync(join(tmpdir(),'synthetic-shared-'));try{
  const first=join(root,'first'),second=join(root,'second'),shared=join(root,'shared');mkdirSync(first);mkdirSync(second);
  const runId=randomUUID();const hash='a'.repeat(64);
  expect(claimSharedSyntheticAcceptanceDirectory(first,runId,hash,shared)).toContain(runId);
  expect(()=>claimSharedSyntheticAcceptanceDirectory(second,runId,hash,shared)).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});
