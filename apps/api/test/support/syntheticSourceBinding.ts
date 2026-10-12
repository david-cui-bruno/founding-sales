import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {z} from 'zod';
/** Bind actual working files, not only the commit label, before loading a model. */
export function snapshotSyntheticAcceptanceSource(repository:string){
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
 const paths=execFileSync('git',['ls-files','-z','--','apps','packages','tools/ask-evaluation','package.json','package-lock.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(Boolean).sort();
 const digest=createHash('sha256');
 for(const path of paths){digest.update(path);digest.update('\0');digest.update(createHash('sha256').update(readFileSync(resolve(repository,path))).digest());}
 return {commit,sha256:digest.digest('hex')};
}
/** Host-wide opaque consumption marker prevents a checkout copy from reusing a run.
 * The exact scope still supplies authority; this marker grants no funds. */
export function claimSharedSyntheticAcceptanceDirectory(repository:string,runId:string,scopeSha256:string,sharedRoot=resolve(homedir(),'.local','state','callie','synthetic-acceptance-claims')){
 z.uuid().parse(runId);z.string().regex(/^[a-f0-9]{64}$/u).parse(scopeSha256);
 mkdirSync(sharedRoot,{recursive:true,mode:0o700});
 const marker=resolve(sharedRoot,runId);mkdirSync(marker,{mode:0o700});
 writeFileSync(resolve(marker,'scope.json'),JSON.stringify({runId,scopeSha256}),{mode:0o600,flag:'wx'});
 const directory=resolve(repository,'.context',`synthetic-acceptance-${runId}`);mkdirSync(resolve(repository,'.context'),{recursive:true,mode:0o700});mkdirSync(directory,{mode:0o700});return directory;
}
