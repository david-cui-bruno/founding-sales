import {fetchSocialImage} from './imageFetch.ts';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,readFile,writeFile,rename,readdir,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {socialAssetOriginSchema,type RegisterSocialAsset,type AssetOrigin} from '@fss/contracts';
import type {AuthedClient} from '../authedClient.ts';
import {socialImageEditSchema,socialImageChooseSchema,type SocialImageEdit,type SocialImageChoose,type SocialImageImportView} from '../../shared/socialImages.ts';
import {normalizeSocialImage} from './imageNormalize.ts';
import {socialImageThumbnail} from './imageThumbnail.ts';
import {createSocialUploadCheckpoint,socialUploadCheckpointSchema,uploadSocialAssetVersion} from './assetUpload.ts';
const meta=z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/u),bytes:z.number().int().positive().max(20*1024*1024),mime:z.enum(['image/png','image/jpeg','image/webp','image/heic']),width:z.number().int().positive().max(4096),height:z.number().int().positive().max(4096)});
const manifestSchema=z.strictObject({id:z.string().uuid(),deleteCommandId:z.string().uuid(),origin:socialAssetOriginSchema,original:meta,base:meta,derivative:meta,derivativeFile:z.string().uuid(),edit:socialImageEditSchema,locked:z.boolean(),originalCheckpoint:socialUploadCheckpointSchema,derivativeCheckpoint:socialUploadCheckpointSchema});
type Manifest=z.infer<typeof manifestSchema>;
interface Deps {
 directory:string;api:AuthedClient;
 identity():Promise<{workspaceId:string;userId:string}|null>;
 generation():number;
 chooseFile():Promise<{canceled:boolean;filePaths:string[]}>;
 readClipboard?():Promise<Buffer|null>;
 fetchImage?:typeof fetchSocialImage;
 put?:Parameters<typeof uploadSocialAssetVersion>[0]['put'];
}
const empty=(reason:string|null=null):SocialImageImportView=>({stage:null,reason,savedAssetId:null});
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
async function boundedFile(path:string,max=20*1024*1024){
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>max)throw new Error('invalid_image');const bytes=Buffer.alloc(stat.size+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead!==stat.size)throw new Error('invalid_image');return bytes.subarray(0,bytesRead);}finally{await handle.close();}
}
function mime(bytes:Buffer):RegisterSocialAsset['mime'] {
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
 if(bytes.toString('ascii',4,8)==='ftyp'&&['heic','heix','mif1'].includes(bytes.toString('ascii',8,12)))return 'image/heic';
 throw new Error('invalid_image');
}
/** One retained stage per owner. Renderer receives opaque IDs and raster previews, never paths. */
export function createSocialImageImport(deps:Deps) {
 let busy=false;
 async function run(action:(ctx:{root:string;current():boolean})=>Promise<SocialImageImportView>):Promise<SocialImageImportView>{
  if(busy)return empty('image_busy');busy=true;const epoch=deps.generation();
  try{const owner=await deps.identity();if(!owner||deps.generation()!==epoch)return empty('session_changed');
   const root=join(deps.directory,'social-image-staging',hash(JSON.stringify([owner.workspaceId,owner.userId])));
   await mkdir(root,{recursive:true,mode:0o700});if(!(await lstat(root)).isDirectory()||(await lstat(root)).isSymbolicLink())return empty('invalid_image');
   const current=()=>deps.generation()===epoch;
   const answer=await action({root,current});return current()?answer:empty('session_changed');
  }catch{return empty('invalid_image');}finally{busy=false;}
 }
 async function load(root:string):Promise<Manifest|null>{
  try{return manifestSchema.parse(JSON.parse((await boundedFile(join(root,'stage.json'),128*1024)).toString('utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 }
 async function save(root:string,m:Manifest){const path=join(root,`${randomUUID()}.tmp`);await writeFile(path,JSON.stringify(manifestSchema.parse(m)),{mode:0o600,flag:'wx'});await rename(path,join(root,'stage.json'));}
 async function view(root:string,m:Manifest,reason:string|null=null):Promise<SocialImageImportView>{
  const bytes=await boundedFile(join(root,m.derivativeFile),5*1024*1024);
  return {stage:{id:m.id,width:m.derivative.width,height:m.derivative.height,baseWidth:m.base.width,baseHeight:m.base.height,preview:await socialImageThumbnail(bytes,m.derivative.sha256),crop:m.edit.crop,redactions:m.edit.redactions,locked:m.locked,usageNote:m.origin.usageNote},reason,savedAssetId:null};
 }
 async function cleanup(root:string,keep:string[]=[]){for(const name of await readdir(root)){if(keep.includes(name))continue;await rm(join(root,name),{recursive:true,force:true});}}
 async function prepare(root:string,current:()=>boolean,original:Buffer,origin:AssetOrigin){
  if(!current())return empty('session_changed');if(original.length>20*1024*1024)throw new Error('invalid_image');const originalMime=mime(original);await cleanup(root);
   await writeFile(join(root,'original'),original,{flag:'wx',mode:0o600});
   try{
    const base=await normalizeSocialImage({inputPath:join(root,'original'),outputPath:join(root,'base'),crop:null,redactions:[],lossless:origin.kind==='screenshot'});
    const id=randomUUID(),derivativeFile=randomUUID();await writeFile(join(root,derivativeFile),await readFile(join(root,'base')),{flag:'wx',mode:0o600});
    const m:Manifest={id,deleteCommandId:randomUUID(),origin,original:{sha256:hash(original),bytes:original.length,mime:originalMime,width:base.width,height:base.height},base,derivative:base,derivativeFile,edit:{id,crop:null,redactions:[]},locked:false,originalCheckpoint:createSocialUploadCheckpoint(hash(original)),derivativeCheckpoint:createSocialUploadCheckpoint(base.sha256)};
    if(!current()){await cleanup(root);return empty('session_changed');}await save(root,m);return view(root,m);
   }catch(error){await cleanup(root);throw error;}
 }

 return {
  state:()=>run(async({root})=>{const m=await load(root);return m?view(root,m):empty();}),
  choose:(raw:SocialImageChoose)=>run(async({root,current})=>{
   const input=socialImageChooseSchema.parse(raw),existing=await load(root);if(existing)return view(root,existing,'finish_current_image');
   const selected=await deps.chooseFile();if(!current())return empty('session_changed');if(selected.canceled||selected.filePaths.length!==1)return empty();
   await cleanup(root);
   const original=await boundedFile(selected.filePaths[0]!);
   if(!current())return empty('session_changed');
   return prepare(root,current,original,{kind:input.kind,sourceUrl:null,usageNote:input.usageNote});
  }),
  paste:({usageNote}:{usageNote:string|null})=>run(async({root,current})=>{
   const existing=await load(root);if(existing)return view(root,existing,'finish_current_image');
   const bytes=await deps.readClipboard?.();if(!bytes)return empty('clipboard_empty');
   return prepare(root,current,bytes,socialAssetOriginSchema.parse({kind:'screenshot',sourceUrl:null,usageNote}));
  }),
  fromUrl:({url,usageNote}:{url:string;usageNote:string|null})=>run(async({root,current})=>{
   const existing=await load(root);if(existing)return view(root,existing,'finish_current_image');
   const source=await (deps.fetchImage??fetchSocialImage)(url);
   return prepare(root,current,source.bytes,socialAssetOriginSchema.parse({kind:'web',sourceUrl:source.sourceUrl,usageNote}));
  }),
  edit:(raw:SocialImageEdit)=>run(async({root,current})=>{
   const input=socialImageEditSchema.parse(raw),m=await load(root);if(!m||m.id!==input.id)return empty('image_not_found');if(m.locked)return view(root,m,'upload_started');
   const file=randomUUID();
   try{const derivative=await normalizeSocialImage({inputPath:join(root,'base'),outputPath:join(root,file),crop:input.crop,redactions:input.redactions,lossless:m.origin.kind==='screenshot'});
    if(!current()){await rm(join(root,file),{force:true});return empty('session_changed');}
    const old=m.derivativeFile;m.derivativeFile=file;m.derivative=derivative;m.edit=input;m.derivativeCheckpoint=createSocialUploadCheckpoint(derivative.sha256);await save(root,m);await rm(join(root,old),{force:true});return view(root,m);
   }catch{await rm(join(root,file),{force:true});return view(root,m,'invalid_crop_or_cover');}
  }),
  upload:({id}:{id:string})=>run(async({root,current})=>{
   const m=await load(root);if(!m||m.id!==id)return empty('image_not_found');m.locked=true;await save(root,m);if(!current())return empty('session_changed');
   const common={api:deps.api,isCurrent:current,...(deps.put?{put:deps.put}:{})};
   const original=await uploadSocialAssetVersion({...common,save:async checkpoint=>{m.originalCheckpoint=checkpoint;await save(root,m);}},{sha256:m.original.sha256,bytes:m.original.bytes,mime:m.original.mime,origin:m.origin},await boundedFile(join(root,'original')),m.originalCheckpoint);
   if(!original.ok)return view(root,m,original.reason);if(!current())return empty('session_changed');
   const derivative=await uploadSocialAssetVersion({...common,save:async checkpoint=>{m.derivativeCheckpoint=checkpoint;await save(root,m);}},{assetId:original.assetId,expectedVersion:original.version,...m.derivative,origin:m.origin},await boundedFile(join(root,m.derivativeFile),5*1024*1024),m.derivativeCheckpoint);
   if(!derivative.ok)return view(root,m,derivative.reason);await cleanup(root);return {...empty(),savedAssetId:derivative.assetId};
  }),
  discard:({id}:{id:string})=>run(async({root,current})=>{
   const m=await load(root);if(!m||m.id!==id)return empty('image_not_found');
   if(m.locked){
    if(!m.originalCheckpoint.assetId){
     // Resolve a possibly lost registration response using its original idempotency key.
     const registered=await deps.api.command('/social/assets/register',{sha256:m.original.sha256,bytes:m.original.bytes,mime:m.original.mime,origin:m.origin},v=>z.strictObject({assetId:z.string().uuid(),uploadId:z.string().uuid()}).parse(v),{commandId:m.originalCheckpoint.registrationCommandId});
     if(!current())return empty('session_changed');if(!registered.ok)return view(root,m,registered.reason);
     m.originalCheckpoint.assetId=registered.value.assetId;m.originalCheckpoint.uploadId=registered.value.uploadId;await save(root,m);
    }
    if(!current())return empty('session_changed');
    const removed=await deps.api.command('/social/assets/delete',{assetId:m.originalCheckpoint.assetId},v=>z.unknown().parse(v),{commandId:m.deleteCommandId});
    if(!current())return empty('session_changed');if(!removed.ok)return view(root,m,'remove_failed');
   }
   await cleanup(root);return empty();
  }),
 };
}
export type SocialImageImport=ReturnType<typeof createSocialImageImport>;
