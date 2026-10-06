import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,openSync,writeSync,closeSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const fail=()=>{throw new Error('SECRET_HISTORY_INCOMPLETE');};
const env=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(?:GIT_|GITLEAKS_)/.test(key)));
function git(root,args,run,input){
 const result=run('git',args,{cwd:root,env:env(),shell:false,encoding:null,maxBuffer:64*1024*1024,timeout:660_000,...(typeof input==='number'?{stdio:[input,'pipe','pipe']}:{input})});
 if(result.error||result.signal||result.status!==0||!Buffer.isBuffer(result.stdout))fail();return result.stdout;
}
function lines(value){return value.toString('ascii').trim().split('\n').filter(Boolean);}
export function historySnapshot(root,run=spawnSync){
 // --all includes HEAD, including a detached HEAD not named by any ref.
 return createHash('sha256').update(git(root,['rev-list','--all'],run)).digest('hex');
}
/** Build a private, read-only projection of ALL reachable historical file contents.
 * A (raw path, blob id) is scanned once. Different paths are never conflated, since
 * detector rules/allowlists are path-sensitive. Source refs/objects are not changed.
 * Synthetic parentless commits ensure the full content is added, never only a diff.
 */
export function stageSecretHistory(root,destination,run=spawnSync){
 const execute=run,deadline=Date.now()+660_000;
 run=(command,args,options)=>{const remaining=deadline-Date.now();if(remaining<=0)fail();return execute(command,args,{...options,timeout:Math.min(options.timeout,remaining)});};
 const before=historySnapshot(root,run);
 const format=git(root,['rev-parse','--show-object-format'],run).toString().trim();
 if(!['sha1','sha256'].includes(format))fail();const oidBytes=format==='sha1'?20:32;
 const valid=id=>new RegExp(`^[0-9a-f]{${oidBytes*2}}$`).test(id);
 const roots=[...new Set(lines(git(root,['rev-list','--all','--format=%T','--no-commit-header'],run)))];
 if(!roots.length||roots.some(id=>!valid(id)))fail();
 const ids=lines(git(root,['rev-list','--objects','--all','--filter=blob:none','--no-object-names'],run));
 if(ids.some(id=>!valid(id)))fail();
 const metadata=lines(git(root,['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],run,ids.join('\n')+'\n'));
 if(metadata.length!==ids.length)fail();const trees=[];
 for(let i=0;i<metadata.length;i++){
  const [id,type,size,...extra]=metadata[i].split(' ');if(id!==ids[i]||extra.length||!['tree','commit','tag'].includes(type)||!/^\d+$/.test(size))fail();
  if(type==='tree')trees.push({id,size:Number(size)});
 }
 const contents=new Map();
 // Batch object reads without exposing blob contents or starting one Git process per tree.
 for(let start=0;start<trees.length;){
  let end=start,bytes=0;while(end<trees.length&&(end===start||bytes+trees[end].size<8*1024*1024)){bytes+=trees[end].size;end++;}
  const batch=trees.slice(start,end),output=git(root,['cat-file','--batch'],run,batch.map(t=>t.id).join('\n')+'\n');let offset=0;
  for(const tree of batch){const newline=output.indexOf(10,offset);if(newline<0||output.subarray(offset,newline).toString()!==`${tree.id} tree ${tree.size}`)fail();
   offset=newline+1;const body=output.subarray(offset,offset+tree.size);offset+=tree.size;if(body.length!==tree.size||output[offset++]!==10)fail();contents.set(tree.id,body);
  }if(offset!==output.length)fail();start=end;
 }
 const pending=roots.map(id=>({id,prefix:Buffer.alloc(0)})),seen=new Set(),files=new Map();
 while(pending.length){const {id,prefix}=pending.pop();const key=id+':'+prefix.toString('hex');if(seen.has(key))continue;seen.add(key);
  const body=contents.get(id);if(!body)fail();let offset=0;
  while(offset<body.length){const space=body.indexOf(32,offset),nul=body.indexOf(0,space+1);if(space<offset||nul<0||nul+1+oidBytes>body.length)fail();
   const mode=body.subarray(offset,space).toString(),name=body.subarray(space+1,nul),object=body.subarray(nul+1,nul+1+oidBytes).toString('hex');offset=nul+1+oidBytes;
   if(!name.length||name.includes(47)||name.equals(Buffer.from('.'))||name.equals(Buffer.from('..')))fail();
   const path=Buffer.concat([prefix,name]);
   if(mode==='40000'){pending.push({id:object,prefix:Buffer.concat([path,Buffer.from('/')])});continue;}
   // A submodule's repository is not in this object database. Never claim to have scanned it.
   if(!['100644','100755','120000'].includes(mode))fail();
   const pathKey=path.toString('hex');if(!files.has(pathKey))files.set(pathKey,{path,versions:new Set()});files.get(pathKey).versions.add(object);
  }
 }
 if(!files.size||historySnapshot(root,run)!==before)fail();
 mkdirSync(destination,{mode:0o700});git(root,['init','--quiet','--bare',`--object-format=${format}`,destination],run);
 // A bare projection must preserve case-distinct Git paths even on a case-insensitive Mac disk.
 git(destination,['config','core.ignorecase','false'],run);
 const objects=realpathSync(git(root,['rev-parse','--path-format=absolute','--git-path','objects'],run).toString().trim());
 if(/[\r\n]/.test(objects))fail();
 // Read existing blobs through Git's object database; never copy cookies, working files,
 // or credentials into a staging checkout. The temporary repository has no remote.
 writeFileSync(join(destination,'objects/info/alternates'),objects+'\n',{mode:0o600,flag:'wx'});
 const inputPath=resolve(destination,'scan-input'),fd=openSync(inputPath,'wx',0o600);
 let commits=0,versions=0;const entries=[...files.values()].map(f=>({...f,versions:[...f.versions]}));
 const max=Math.max(...entries.map(f=>f.versions.length));
 const quote=path=>'"'+[...path].map(b=>b>=32&&b<=126&&b!==34&&b!==92?String.fromCharCode(b):'\\'+b.toString(8).padStart(3,'0')).join('')+'"';
 const emit=group=>{if(!group.length)return;commits++;
  writeSync(fd,`commit refs/heads/batch-${commits}\ncommitter Secret verification <scan@example.invalid> 1 +0000\ndata 0\n`);
  for(const item of group){writeSync(fd,`M 100644 ${item.oid} ${quote(item.path)}\n`);versions++;}writeSync(fd,'\n');
 };
 try{
  for(let index=0;index<max;index++){
   let group=[],selected=new Set(),directories=new Set();
   for(const file of entries){const oid=file.versions[index];if(!oid)continue;const key=file.path.toString('hex'),parents=[];
    for(let i=0;i<file.path.length;i++)if(file.path[i]===47)parents.push(file.path.subarray(0,i).toString('hex'));
    if(directories.has(key)||parents.some(p=>selected.has(p))){emit(group);group=[];selected=new Set();directories=new Set();}
    selected.add(key);for(const parent of parents)directories.add(parent);group.push({path:file.path,oid});
   }emit(group);
  }writeSync(fd,'done\n');
 }finally{closeSync(fd);}
 const input=openSync(inputPath,'r');try{git(destination,['fast-import','--quiet','--done'],run,input);}finally{closeSync(input);rmSync(inputPath);}
 // Verify the projection, rather than trusting fast-import to preserve all paths.
 const expected=new Set(entries.flatMap(f=>f.versions.map(oid=>oid+':'+f.path.toString('hex'))));
 for(let number=1;number<=commits;number++){
  const tree=git(destination,['ls-tree','-rz',`refs/heads/batch-${number}`],run);let offset=0;
  while(offset<tree.length){const nul=tree.indexOf(0,offset),tab=tree.indexOf(9,offset);if(nul<0||tab<offset||tab>nul)fail();
   const [mode,type,oid]=tree.subarray(offset,tab).toString().split(' '),path=tree.subarray(tab+1,nul);
   if(mode!=='100644'||type!=='blob'||!expected.delete(oid+':'+path.toString('hex')))fail();offset=nul+1;
  }
 }
 if(expected.size||historySnapshot(root,run)!==before)fail();
 return {path:destination,versions,paths:files.size,commits,snapshot:before};
}
