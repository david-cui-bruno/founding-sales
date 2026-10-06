import {createRequire} from 'node:module';
import {cp,mkdir,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
const require=createRequire(import.meta.url);
/** Explicit runtime allowlist. Never copy the workspace node_modules tree into the app. */
export async function copySocialImageRuntime(staging:string):Promise<string[]>{
 const sharpEntry=require.resolve('sharp');const fromSharp=createRequire(sharpEntry);
 const platform=`${process.platform}-${process.arch}`;
 if(!['darwin-arm64','darwin-x64','linux-x64','linux-arm64'].includes(platform))throw new Error('unsupported_image_runtime');
 const names=['sharp','@img/colour','detect-libc','semver',`@img/sharp-${platform}`,`@img/sharp-libvips-${platform}`];
 for(const name of names){
  let location:string|null=null;
  for(const directory of fromSharp.resolve.paths(name)??[]){
   const candidate=join(directory,name);
   try{const manifest=JSON.parse(await readFile(join(candidate,'package.json'),'utf8')) as {name?:string};if(manifest.name===name){location=candidate;break;}}catch{/* Try the next Node resolution directory. */}
  }
  if(location===null)throw new Error('image_runtime_package_missing');
  const target=join(staging,'node_modules',name);await mkdir(dirname(target),{recursive:true});await cp(location,target,{recursive:true,dereference:true});
 }
 return names;
}
