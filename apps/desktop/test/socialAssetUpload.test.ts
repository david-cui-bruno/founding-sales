import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import type {AuthedClient} from '../src/main/authedClient.ts';
import {createSocialUploadCheckpoint,uploadSocialAssetVersion} from '../src/main/social/assetUpload.ts';
it('resumes an interrupted immutable upload without minting another registration',async()=>{
 const bytes=Buffer.from('fixture'),sha256=createHash('sha256').update(bytes).digest('hex');
 const checkpoint=createSocialUploadCheckpoint(sha256);let saved=structuredClone(checkpoint);let sends=0;
 const command=vi.fn(async(path:string)=>({ok:true as const,value:path.endsWith('register')?{assetId:'11111111-1111-4111-8111-111111111111',uploadId:'22222222-2222-4222-8222-222222222222'}:{version:1}}));
 const api={command,read:async()=>({ok:true,value:{url:'https://bucket.s3.us-east-1.amazonaws.com/image',headers:{},expiresAt:'2099-01-01T00:00:00Z'}})} as unknown as AuthedClient;
 const input={sha256,bytes:bytes.length,mime:'image/png' as const,origin:{kind:'upload' as const,sourceUrl:null,usageNote:null}};
 const deps={api,isCurrent:()=>true,save:async(value:typeof checkpoint)=>{saved=structuredClone(value);},put:async()=>{sends++;if(sends===1)throw new Error('disconnected');return {status:412};}};
 expect(await uploadSocialAssetVersion(deps,input,bytes,checkpoint)).toEqual({ok:false,reason:'upload_interrupted'});
 expect(saved.assetId).toBe('11111111-1111-4111-8111-111111111111');
 expect(await uploadSocialAssetVersion(deps,input,bytes,saved)).toEqual({ok:true,assetId:saved.assetId,version:1});
 expect(command.mock.calls.filter(([path])=>path.endsWith('register'))).toHaveLength(1);
});
it('stops before storage traffic if the account changes after registration',async()=>{
 const bytes=Buffer.from('fixture'),sha256=createHash('sha256').update(bytes).digest('hex');let current=true;
 const api={command:async()=>{current=false;return {ok:true,value:{assetId:'11111111-1111-4111-8111-111111111111',uploadId:'22222222-2222-4222-8222-222222222222'}};},read:vi.fn()} as unknown as AuthedClient;
 const put=vi.fn();expect(await uploadSocialAssetVersion({api,isCurrent:()=>current,save:async()=>{},put},{sha256,bytes:bytes.length,mime:'image/png',origin:{kind:'upload',sourceUrl:null,usageNote:null}},bytes,createSocialUploadCheckpoint(sha256))).toEqual({ok:false,reason:'session_changed'});
 expect(put).not.toHaveBeenCalled();expect(api.read).not.toHaveBeenCalled();
});
it('recovers a completion whose response was lost without asking for another upload',async()=>{
 const bytes=Buffer.from('fixture'),sha256=createHash('sha256').update(bytes).digest('hex');let saved=createSocialUploadCheckpoint(sha256);let complete=false;
 const assetId='11111111-1111-4111-8111-111111111111',uploadId='22222222-2222-4222-8222-222222222222';
 const origin={kind:'upload' as const,sourceUrl:null,usageNote:null};
 const api={command:async(path:string)=>{if(path.endsWith('register'))return {ok:true,value:{assetId,uploadId}};complete=true;throw new Error('response lost');},read:async(path:string)=>path.endsWith('/read')?{ok:true,value:{asset:{id:assetId,state:'ready',version:1,origin,objects:[{version:1,kind:'original',state:'ready',sha256,bytes:bytes.length,mime:'image/png',width:null,height:null}]}}}:complete?{ok:false,reason:'not_found'}:{ok:true,value:{url:'https://bucket.s3.us-east-1.amazonaws.com/image',headers:{},expiresAt:'2099-01-01T00:00:00Z'}}} as unknown as AuthedClient;
 const put=vi.fn(async()=>({status:200})),deps={api,isCurrent:()=>true,save:async(value:typeof saved)=>{saved=structuredClone(value);},put};const input={sha256,bytes:bytes.length,mime:'image/png' as const,origin};
 expect((await uploadSocialAssetVersion(deps,input,bytes,saved)).ok).toBe(false);
 expect(await uploadSocialAssetVersion(deps,input,bytes,saved)).toEqual({ok:true,assetId,version:1});expect(put).toHaveBeenCalledTimes(1);
});
