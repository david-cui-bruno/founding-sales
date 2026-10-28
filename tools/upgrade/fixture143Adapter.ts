import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,copyFile,symlink,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const FIXTURE_143_BASE='39ca16123028db8dd431696e9601552066b3379d';
const orchestration=['fixtureMain.ts','fixture.ts','fixtureRegistry.ts','fixtureProtocol.ts','fixtureManifest.ts','snapshot.ts'];
const imports=[['@fss/contracts','packages/contracts/src/index.ts'],['@fss/domain/db/queryable.ts','packages/domain/db/queryable.ts'],['@fss/api/src/server.ts','apps/api/src/server.ts'],['@fss/worker','apps/worker/src/index.ts'],['../../apps/worker/src/tools/fss/bootstrapWorkspace.ts','apps/worker/src/tools/fss/bootstrapWorkspace.ts']] as const;
/** A fixture-orchestration correction for one recognized stale deployed loader.
 * Business modules, relative worker imports and locked dependencies remain BASE.
 * No base tracked byte is copied over or edited, and unsupported bases never opt in. */
export async function prepareFixture143Adapter(base:string,head:string,schema:number){
 const identity=(await exec('git',['rev-parse','HEAD'],{cwd:base})).stdout.trim();
 if(identity!==FIXTURE_143_BASE||schema!==143)throw Error('Unsupported schema143 fixture adapter identity');
 if((await exec('git',['status','--porcelain','--untracked-files=all'],{cwd:base})).stdout.trim())throw Error('Fixture adapter refuses a dirty base checkout');
 const root=await mkdtemp(join(tmpdir(),'fss-upgrade-fixture143-'));
 try{
  const directory=join(root,'tools','upgrade');await mkdir(directory,{recursive:true});
  for(const name of orchestration)await copyFile(join(head,'tools','upgrade',name),join(directory,name));
  await writeFile(join(root,'package.json'),'{"type":"module"}\n');
  await symlink(join(base,'node_modules'),join(root,'node_modules'));
  await symlink(join(base,'apps'),join(root,'apps'));
  const loader=join(directory,'fixtureMain.ts');
  await verifyFixture143Imports(loader,base);
  return {loader,origin:`head fixture-only schema143 registry adapter; ALL business code/contracts/relative apps from exact base ${identity}; base-locked third-party modules`,cleanup:()=>rm(root,{recursive:true,force:true})};
 }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
/** Resolve from the actual shadow entry's location, not from HEAD's process. The
 * child resolves only; importing would execute fixtureMain and open a database. */
export async function verifyFixture143Imports(loader:string,base:string):Promise<void>{
 const probe=join(loader,'..','provenance.mjs');
 await writeFile(probe,`process.stdout.write(JSON.stringify(${JSON.stringify(imports.map(([specifier])=>specifier))}.map(s=>import.meta.resolve(s))));\n`);
 try{
  const {stdout}=await exec(process.execPath,[probe]);const resolved:unknown=JSON.parse(stdout);
  if(!Array.isArray(resolved)||resolved.length!==imports.length||!resolved.every(value=>typeof value==='string'))throw Error('Invalid fixture import provenance');
  for(let i=0;i<imports.length;i++)if(await realpath(fileURLToPath(new URL(String(resolved[i]))))!==await realpath(join(base,imports[i]![1])))throw Error(`Fixture adapter import escaped base: ${imports[i]![0]}`);
 }finally{await rm(probe,{force:true});}
 // The package trees themselves must also be base-owned, including packages with
 // no root export (api/domain). This catches a mixed @fss link farm before loading.
 for(const [name,path]of [['contracts','packages/contracts'],['domain','packages/domain'],['api','apps/api'],['worker','apps/worker']]){
  const shadowPackage=new URL(`../../node_modules/@fss/${name}/package.json`,pathToFileURL(loader));
  if(await realpath(fileURLToPath(shadowPackage))!==await realpath(join(base,path!,'package.json')))throw Error(`Fixture adapter package escaped base: ${name}`);
 }
}
export async function recognizedFixture143Adapter(base:string,schema:number):Promise<boolean>{
 let identity:string;try{identity=(await exec('git',['rev-parse','HEAD'],{cwd:base})).stdout.trim();}catch{return false;}
 return identity===FIXTURE_143_BASE&&schema===143;
}
