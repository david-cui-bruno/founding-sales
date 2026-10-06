import {mkdtemp,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {afterEach,expect,it,vi} from 'vitest';
import {createSocialImageImport} from '../src/main/social/imageImport.ts';
import type {AuthedClient} from '../src/main/authedClient.ts';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'social-import-test-'));roots.push(root);const path=join(root,'phone.png');
 await sharp({create:{width:100,height:80,channels:3,background:'red'}}).png().toFile(path);
 let owner={workspaceId:'workspace-a',userId:'owner-a'};let generation=0;let fail=true;
 const command=vi.fn(async(route:string,input:unknown)=>({ok:true as const,value:route.endsWith('register')?{assetId:'11111111-1111-4111-8111-111111111111',uploadId:(input as {assetId?:string}).assetId?'33333333-3333-4333-8333-333333333333':'22222222-2222-4222-8222-222222222222'}:{version:1}}));
 const api={command,read:async()=>({ok:true,value:{url:'https://bucket.s3.us-east-1.amazonaws.com/image',headers:{},expiresAt:'2099-01-01T00:00:00Z'}})} as unknown as AuthedClient;
 const deps={directory:root,api,identity:async()=>owner,generation:()=>generation,chooseFile:async()=>({canceled:false,filePaths:[path]}),put:async()=>{if(fail)throw new Error('offline');return {status:200};}};
 return {root,path,deps,command,host:createSocialImageImport(deps),online:()=>{fail=false;},switchOwner:()=>{generation++;owner={workspaceId:'workspace-b',userId:'owner-b'};}};
}
it('preserves original, previews edits and recovers staged work after restart',async()=>{
 const f=await fixture(),original=await readFile(f.path);
 const chosen=await f.host.choose({kind:'phone',usageNote:'My photo'});expect(chosen.reason).toBeNull();expect(chosen.stage?.width).toBe(100);
 const id=chosen.stage!.id;
 const edited=await f.host.edit({id,crop:{x:0,y:0,width:60,height:40},redactions:[{x:0,y:0,width:10,height:10}]});
 expect(edited.stage?.width).toBe(60);expect(edited.stage?.preview).toMatch(/^data:image\/png;base64,/);
 expect(await readFile(f.path)).toEqual(original);
 const restarted=createSocialImageImport(f.deps);expect((await restarted.state()).stage?.id).toBe(id);
 expect((await restarted.upload({id})).reason).toBe('upload_interrupted');
 f.online();expect((await restarted.upload({id})).savedAssetId).toBe('11111111-1111-4111-8111-111111111111');
 expect(f.command.mock.calls.filter(([route])=>route.endsWith('register'))).toHaveLength(2);
 expect((await restarted.state()).stage).toBeNull();
});
it('does not expose another owner stage or accept renderer filesystem paths',async()=>{
 const f=await fixture();const chosen=await f.host.choose({kind:'upload',usageNote:null});f.switchOwner();
 expect((await f.host.state()).stage).toBeNull();expect((await f.host.upload({id:chosen.stage!.id})).reason).toBe('image_not_found');expect(f.command).not.toHaveBeenCalled();
});
it('rejects symlinks before reading and changes no server state',async()=>{
 const f=await fixture();const link=join(f.root,'alias.png');await symlink(f.path,link);f.deps.chooseFile=async()=>({canceled:false,filePaths:[link]});
 const result=await createSocialImageImport(f.deps).choose({kind:'upload',usageNote:null});expect(result.stage).toBeNull();expect(result.reason).toBe('invalid_image');expect(f.command).not.toHaveBeenCalled();
});
it('locks editing after an upload starts so retry cannot change registered bytes',async()=>{
 const f=await fixture();const chosen=await f.host.choose({kind:'upload',usageNote:null}),id=chosen.stage!.id;
 await f.host.upload({id});expect((await f.host.edit({id,crop:null,redactions:[]})).reason).toBe('upload_started');
});
it('can abandon an interrupted upload only after the server confirms asset removal',async()=>{
 const f=await fixture();const chosen=await f.host.choose({kind:'upload',usageNote:null}),id=chosen.stage!.id;
 await f.host.upload({id});const removed=await f.host.discard({id});expect(removed.stage).toBeNull();
 expect(f.command.mock.calls.some(([route])=>route==='/social/assets/delete')).toBe(true);expect((await f.host.state()).stage).toBeNull();
});
it('prepares an explicitly pasted image without uploading it',async()=>{
 const f=await fixture();const host=createSocialImageImport({...f.deps,readClipboard:async()=>readFile(f.path)});
 const result=await host.paste({usageNote:'Screenshot'});expect(result.stage?.width).toBe(100);expect(f.command).not.toHaveBeenCalled();
});
it('retains an explicitly fetched image source without uploading during preview',async()=>{
 const f=await fixture();const sourceUrl='https://images.example.test/photo.png';
 const fetchImage=vi.fn(async()=>({bytes:await readFile(f.path),sourceUrl,mime:'image/png'}));
 const host=createSocialImageImport({...f.deps,fetchImage});const result=await host.fromUrl({url:sourceUrl,usageNote:'Public source'});
 expect(result.stage?.width).toBe(100);expect(fetchImage).toHaveBeenCalledWith(sourceUrl);expect(f.command).not.toHaveBeenCalled();
 f.online();await host.upload({id:result.stage!.id});
 expect((f.command.mock.calls[0]![1] as {origin:{sourceUrl:string}}).origin.sourceUrl).toBe(sourceUrl);
});
