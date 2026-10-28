import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,symlink,realpath,mkdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {prepareCheckout} from '../../tools/upgrade/baseCheckout.ts';
import {FIXTURE_143_BASE,prepareFixture143Adapter,recognizedFixture143Adapter,verifyFixture143Imports} from '../../tools/upgrade/fixture143Adapter.ts';
import {repositoryPath} from './support/repository.ts';
let root:string,base:string;
const head=repositoryPath('.');
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'fss-fixture143-check-'));base=join(root,'base');git(root,'clone','--shared','--no-checkout','--quiet',head,base);git(base,'checkout','--quiet','--detach',FIXTURE_143_BASE);});
afterAll(async()=>{if(root)await rm(root,{recursive:true,force:true});});
it('uses only recognized143 fixture orchestration, resolves every business import to locked base, and never changes tracked base bytes',async()=>{
 const before=await readFile(join(base,'tools/upgrade/fixture.ts')),prepared=await prepareCheckout(base,head),shadow=dirname(dirname(dirname(prepared.loader)));
 try{
  expect(prepared.fixtureOrigin).toContain('head fixture-only schema143 registry adapter');expect(prepared.fixtureOrigin).toContain(FIXTURE_143_BASE);expect(prepared.modules).toBe('linked from HEAD (identical lockfile)');
  expect(prepared.loader.startsWith(base)).toBe(false);await expect(verifyFixture143Imports(prepared.loader,base)).resolves.toBeUndefined();
  expect(await realpath(join(shadow,'node_modules'))).toBe(await realpath(join(base,'node_modules')));
  expect(await readFile(join(base,'tools/upgrade/fixture.ts'))).toEqual(before);expect(git(base,'status','--porcelain')).toBe('');
 }finally{await prepared.cleanup();}
 await expect(readFile(join(shadow,'package.json'))).rejects.toMatchObject({code:'ENOENT'});expect(git(base,'status','--porcelain')).toBe('');
});
it('other baselines keep their original loader selection and explicitly requesting an unsupported adapter identity refuses',async()=>{
 expect(await recognizedFixture143Adapter(head,144)).toBe(false);expect(await recognizedFixture143Adapter(base,142)).toBe(false);
 await expect(prepareFixture143Adapter(head,head,143)).rejects.toThrow('Unsupported schema143 fixture adapter identity');await expect(prepareFixture143Adapter(base,head,142)).rejects.toThrow('Unsupported schema143 fixture adapter identity');
});
it('refuses a dirty recognized base before creating a shadow rather than laundering changed business/fixture code',async()=>{
 const path=join(base,'tools/upgrade/fixture.ts'),before=await readFile(path);
 try{await writeFile(path,Buffer.concat([before,Buffer.from('\n// unapproved fixture mutation\n')]));await expect(prepareFixture143Adapter(base,head,143)).rejects.toThrow('dirty base');}
 finally{await writeFile(path,before);}expect(git(base,'status','--porcelain')).toBe('');
});
it('refuses a mixed first-party link farm even with an otherwise matching baseline and dependency lock',async()=>{
 const prepared=await prepareCheckout(base,head),link=join(base,'node_modules/@fss/api');
 try{await rm(link);await symlink(join(head,'apps/api'),link);await expect(verifyFixture143Imports(prepared.loader,base)).rejects.toThrow('escaped base');}
 finally{await prepared.cleanup();}expect(git(base,'status','--porcelain')).toBe('');
});

it('copied current fixture resolves against an actual pre-registry base with no registry helper, without invoking a business command',async()=>{
 const old='c5a67bf4c7136f3742291b1c9f16ad1e65d2e07f';git(base,'checkout','--quiet','--detach',old);
 let prepared:Awaited<ReturnType<typeof prepareCheckout>>|undefined;
 const shadow=join(root,'old-shadow'),directory=join(shadow,'tools/upgrade');
 try{
  await expect(readFile(join(base,'packages/domain/test/support/nationalRegistry.ts'))).rejects.toMatchObject({code:'ENOENT'});
  prepared=await prepareCheckout(base,head);expect(prepared.fixtureOrigin).toBeUndefined();expect(prepared.loader).toBe(join(base,'tools/upgrade/fixtureMain.ts'));
  // Use the base lock's installed dependencies even for this resolution-only
  // control; no fixture/business/provider command executes in this child.
  await mkdir(directory,{recursive:true});await writeFile(join(shadow,'package.json'),'{"type":"module"}');
  for(const name of ['fixture.ts','fixtureManifest.ts','snapshot.ts','fixtureRegistry.ts'])await copyFile(join(head,'tools/upgrade',name),join(directory,name));
  await symlink(join(base,'node_modules'),join(shadow,'node_modules'));await symlink(join(base,'apps'),join(shadow,'apps'));
  expect(execFileSync(process.execPath,['--experimental-transform-types','--disable-warning=ExperimentalWarning','--input-type=module','--eval',`await import(${JSON.stringify(pathToFileURL(join(directory,'fixture.ts')).href)});process.stdout.write('resolved without registry helper');`],{encoding:'utf8',env:{...process.env,FSS_UPGRADE_DATABASE_URL:''}})).toBe('resolved without registry helper');
  expect(git(base,'status','--porcelain')).toBe('');
 }finally{await prepared?.cleanup();await rm(shadow,{recursive:true,force:true});git(base,'checkout','--quiet','--detach',FIXTURE_143_BASE);}
});
