import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach,expect,it} from 'vitest';
import {stageSecretHistory} from '../../scripts/secretHistory.mjs';
const directories:string[]=[];
function command(root:string,args:string[],input?:string){
 const result=spawnSync('git',args,{cwd:root,input,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},timeout:20_000});
 if(result.status!==0)throw new Error('fixture_git_failed');return result.stdout.trim();
}
function fixture(){const root=mkdtempSync(join(tmpdir(),'callie-history-test-'));directories.push(root);const repo=join(root,'source');mkdirSync(repo);command(repo,['init','-q']);return {root,repo};}
let checkpointNumber=0;
function checkpoint(repo:string,entries:[string,string,string][]){
 const tree=command(repo,['mktree'],entries.map(([mode,oid,path])=>`${mode} ${mode==='160000'?'commit':'blob'} ${oid}\t${JSON.stringify(path)}\n`).join(''));
 return command(repo,['commit-tree',tree], `fixture snapshot ${checkpointNumber++}\n`);
}
function blob(repo:string,text:string){return command(repo,['hash-object','-w','--stdin'],text);}
function pairs(repo:string){const result=new Set<string>();for(const commit of command(repo,['rev-list','--all']).split('\n')){
 const rows=spawnSync('git',['ls-tree','-rz',commit],{cwd:repo}).stdout;
 for(const row of rows.toString('utf8').split('\0').filter(Boolean)){const [meta,...parts]=row.split('\t');result.add(`${meta!.split(' ')[2]}:${parts.join('\t')}`);}
 }return [...result].sort();}
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
it('retains every path/blob pair across deleted history, side refs and duplicate parentless checkpoints',()=>{
 const {root,repo}=fixture();writeFileSync(join(repo,'old.txt'),'old historical content');command(repo,['add','.']);command(repo,['commit','-qm','old']);
 writeFileSync(join(repo,'old.txt'),'replacement');command(repo,['commit','-qam','new']);
 command(repo,['rm','old.txt']);command(repo,['commit','-qm','delete']);
 const same=blob(repo,'checkpoint only');const entries:[string,string,string][]=[['100644',same,'same.txt'],['100644',same,'Same.txt'],['100644',same,'space tab\tline\n雪.txt'],['120000',blob(repo,'target'),'link']];
 for(let i=0;i<12;i++)command(repo,['update-ref',`refs/conductor-checkpoints/${i}`,checkpoint(repo,entries)]);
 const refs=command(repo,['show-ref']);const expected=pairs(repo);const result=stageSecretHistory(repo,join(root,'history'));
 expect(pairs(result.path)).toEqual(expected);expect(result.versions).toBe(expected.length);expect(result.versions).toBe(6);
 expect(command(repo,['rev-list','--all','--count'])).not.toBe(command(result.path,['rev-list','--all','--count']));
 expect(command(repo,['show-ref'])).toBe(refs);
});
it('retains a path that was a file and later a directory, and distinct versions of one filename',()=>{
 const {root,repo}=fixture();writeFileSync(join(repo,'a'),'first');command(repo,['add','.']);command(repo,['commit','-qm','file']);
 command(repo,['rm','a']);mkdirSync(join(repo,'a'));writeFileSync(join(repo,'a','b'),'second');command(repo,['add','.']);command(repo,['commit','-qm','directory']);
 const result=stageSecretHistory(repo,join(root,'history'));expect(pairs(result.path)).toEqual(pairs(repo));
});
it('fails closed on submodules rather than silently omitting them',()=>{
 const {root,repo}=fixture();const commit=checkpoint(repo,[['100644',blob(repo,'test'),'file']]);
 command(repo,['update-ref','refs/heads/submodule',checkpoint(repo,[['160000',commit,'submodule']])]);
 expect(()=>stageSecretHistory(repo,join(root,'history'))).toThrow();
});
it('fails on a truncated Git object response',()=>{
 const {root,repo}=fixture();command(repo,['update-ref','refs/heads/main',checkpoint(repo,[['100644',blob(repo,'test'),'file']])]);
 expect(()=>stageSecretHistory(repo,join(root,'history'),(cmd,args,options)=>{
  const result=spawnSync(cmd,args,options);return args.includes('--batch')?{...result,stdout:Buffer.from('truncated')}:result;
 })).toThrow();
});
const scannerAvailable=spawnSync('gitleaks',['version'],{encoding:'utf8'}).stdout?.trim()==='8.30.1';
it.skipIf(!scannerAvailable)('the real scanner still finds checkpoint-only and deleted secrets and preserves path-specific exceptions',()=>{
 const {root,repo}=fixture();const marker='TEST_'+'SECRET_fixture_123';
 const oid=blob(repo,marker+'\n');const first=checkpoint(repo,[['100644',oid,'allowed.txt'],['100644',oid,'not-allowed.txt']]);command(repo,['update-ref','refs/conductor-checkpoints/only',first]);
 writeFileSync(join(repo,'deleted.txt'),marker+'\n');command(repo,['add','.']);command(repo,['commit','-qm','before']);command(repo,['rm','deleted.txt']);command(repo,['commit','-qm','after']);
 const config=join(root,'rules.toml');writeFileSync(config,`[[rules]]\nid="fixture"\nregex='''TEST_SECRET_[a-z0-9_]+'''\n[[rules.allowlists]]\npaths=['''^allowed\\.txt$''']\n`);
 const scan=(target:string,name:string)=>{const report=join(root,name+'.json');const result=spawnSync('gitleaks',['git','--redact=100','--no-banner','--no-color','--config',config,'--report-format','json','--report-path',report,'--log-opts=--all --full-history -m',target],{cwd:root,encoding:'utf8',timeout:30_000});expect(result.status).toBe(1);const findings=JSON.parse(readFileSync(report,'utf8')) as {File:string}[];return [...new Set(findings.map(f=>f.File))].sort();};
 expect(scan(stageSecretHistory(repo,join(root,'history')).path,'dedup')).toEqual(scan(repo,'original'));
 expect(scan(repo,'again')).toEqual(['deleted.txt','not-allowed.txt']);
});

it.skipIf(!scannerAvailable)('the verification entry point scans the deduplicated history and the current build context',()=>{
 const {repo}=fixture();writeFileSync(join(repo,'clean.txt'),'clean content');writeFileSync(join(repo,'.gitleaks.toml'),`[[rules]]\nid="fixture"\nregex='''TEST_SECRET_[a-z0-9_]+'''\n`);command(repo,['add','.']);command(repo,['commit','-qm','clean']);
 const module=pathToFileURL(join(import.meta.dirname,'../../scripts/verifySecrets.mjs')).href;
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import {verifySecrets} from ${JSON.stringify(module)};console.log(JSON.stringify(verifySecrets({root:process.argv[1]})));`,repo],{encoding:'utf8',timeout:30_000});
 expect(result.status).toBe(0);const output=JSON.parse(result.stdout) as {kind:string;status:string;versions?:number}[];
 expect(output).toEqual([expect.objectContaining({kind:'history',status:'passed',versions:2}),expect.objectContaining({kind:'context',status:'passed'})]);
});
it.skipIf(!scannerAvailable)('fixture exceptions cover only the exact fake values at their exact test paths',()=>{
 const {root,repo}=fixture();
 const nonce='b6bacf0c-28b2-4290-8eaa-c8647020c3c8',other='9b40c38a-ed43-43d0-b227-177c08724fc6',sentinel=['SENTINEL','api-key-secret','0123456789'].join('-');
 const files:Record<string,string>={
  'apps/desktop/test/linkedinSubmit.test.ts':`token: '${nonce}'\ntoken: '${other}'\ntoken: '${nonce.replace(/^b/,'c')}'`,
  'apps/desktop/test/linkedinDetailNavigation.test.ts':`token: '${nonce}'`,
  'apps/desktop/test/linkedinImageSubmit.test.ts':`token: '${nonce}'`,
  'apps/desktop/test/linkedinMediaCapture.test.ts':`token: '${nonce}'\ntoken: '${other}'`,
  'apps/desktop/test/linkedinSavedAlt.test.ts':`token: '${nonce}'\ntoken: '${other}'`,
  'apps/desktop/test/host/support/socialImageStageProbe.ts':`token: '${nonce}'`,
  'apps/desktop/test/host/support/socialTextSubmitProbe.ts':`token: '${nonce}'\ntoken: '${other}'`,
  'apps/api/test/integrationsSettings.test.ts':`api_key_secret: '${sentinel}'\napi_key_secret: '${sentinel}x'`,
  'outside.ts':`token: '${nonce}'\napi_key_secret: '${sentinel}'`,
 };
 for(const [path,body] of Object.entries(files)){const parent=join(repo,path,'..');mkdirSync(parent,{recursive:true});writeFileSync(join(repo,path),body);}
 command(repo,['add','.']);command(repo,['commit','-qm','fixtures']);const report=join(root,'findings.json');
 const result=spawnSync('gitleaks',['git','--redact=100','--no-banner','--no-color','--config',join(import.meta.dirname,'../../.gitleaks.toml'),'--report-format','json','--report-path',report,'--log-opts=--all --full-history -m',repo],{encoding:'utf8',timeout:30_000});
 expect(result.status).toBe(1);const findings=JSON.parse(readFileSync(report,'utf8')) as {File:string;StartLine:number}[];
 expect(findings.map(f=>`${f.File}:${f.StartLine}`).sort()).toEqual(['apps/api/test/integrationsSettings.test.ts:2','apps/desktop/test/linkedinSubmit.test.ts:3','outside.ts:1','outside.ts:2']);
});
