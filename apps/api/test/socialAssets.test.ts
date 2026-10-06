import {it,expect} from 'vitest';
import {loadSocialMediaStore,type SocialMediaSdk} from '../src/social/mediaStore.ts';
it('signs only one immutable body for ten minutes and verifies checksum, type and upload identity',async()=>{
 const calls:Record<string,unknown>[]=[],signed:{command:unknown;options:unknown}[]=[];
 class Command{constructor(readonly input:Record<string,unknown>){calls.push(input);}}
 const sdk:SocialMediaSdk={S3Client:class{async send(){return {ContentLength:20,ContentType:'image/png',ChecksumSHA256:Buffer.from('a'.repeat(64),'hex').toString('base64'),Metadata:{'callie-upload':'upload'}};}},PutObjectCommand:Command,HeadObjectCommand:Command,GetObjectCommand:Command,DeleteObjectCommand:Command,getSignedUrl:async(_c,command,options)=>{signed.push({command,options});return 'https://fixture.invalid/signed';}};
 const store=await loadSocialMediaStore({bucket:'social-private',region:'us-east-1',sdk});
 const input={key:'workspace/asset/1/upload',sha256:'a'.repeat(64),bytes:20,mime:'image/png',uploadId:'upload',issuedAt:'2026-10-01T12:00:00.000Z'};
 const put=await store.presignPut(input);
 expect(put.headers).toMatchObject({'content-type':'image/png','content-length':'20','x-amz-meta-callie-upload':'upload','if-none-match':'*'});
 expect(calls[0]).toMatchObject({Bucket:'social-private',Key:input.key,IfNoneMatch:'*'});
 expect(signed[0]?.options).toMatchObject({expiresIn:600,signingDate:new Date(input.issuedAt)});
 expect(put.expiresAt).toBe('2026-10-01T12:10:00.000Z');
 expect(await store.head(input.key)).toEqual({found:true,sha256:input.sha256,bytes:20,mime:'image/png',uploadId:'upload'});
 await store.presignGet(input.key);expect(signed[1]?.options).toMatchObject({expiresIn:600});
});
it('does not turn an authorization or network error into proof of absence',async()=>{
 class Command{constructor(readonly input:Record<string,unknown>){}}
 const sdk:SocialMediaSdk={S3Client:class{async send(){throw {$metadata:{httpStatusCode:403}};}},PutObjectCommand:Command,HeadObjectCommand:Command,GetObjectCommand:Command,DeleteObjectCommand:Command,getSignedUrl:async()=>''};
 const store=await loadSocialMediaStore({bucket:'private',region:'us-east-1',sdk});
 await expect(store.head('key')).rejects.toThrow('media_store_unavailable');await expect(store.delete('key')).rejects.toThrow('media_store_unavailable');
});

it('the authenticated API does not trust browser completion metadata, and deleted/replayed registrations cannot yield URLs',async()=>{
 const {randomUUID}=await import('node:crypto');const {createAuthFixture,CURRENT_CLIENT_VERSION}=await import('./support/authFixture.ts');const {issueSessionFor}=await import('./support/sessionFixture.ts');const {dispatch}=await import('../src/server.ts');
 const f=await createAuthFixture();try{
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;let headCalls=0;
 const media={presignPut:async()=>({url:'https://fixture.invalid/private',headers:{},expiresAt:new Date().toISOString()}),presignGet:async()=>({url:'https://fixture.invalid/private',expiresAt:new Date().toISOString()}),head:async()=>{headCalls++;return {found:false as const};},delete:async()=>{}};
 const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,socialMedia:media,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
 const body={sha256:'a'.repeat(64),bytes:100,mime:'image/png',origin:{kind:'upload',sourceUrl:null,usageNote:null},commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 const r=await call('/social/assets/register',body);expect(r.status).toBe(200);const ids=(r.body as {result:{assetId:string;uploadId:string}}).result;
 expect((await call('/social/assets/read',{assetId:ids.assetId})).body).toMatchObject({asset:{id:ids.assetId,state:'uploading'}});
 expect((await call('/social/assets/upload-url',ids)).status).toBe(200);
 expect((await call('/social/assets/complete',{...ids,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,verified:{bytes:100,sha256:body.sha256,mime:'image/png'}})).status).toBe(400);expect(headCalls).toBe(0);
 expect((await call('/social/assets/complete',{...ids,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION})).status).toBe(409);expect(headCalls).toBe(1);
 expect((await call('/social/assets/delete',{assetId:ids.assetId,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION})).status).toBe(200);
 expect((await call('/social/assets/register',body)).body).toMatchObject({replayed:true});
 expect((await call('/social/assets/upload-url',ids)).status).toBe(404);
 expect((await call('/social/assets/read',{assetId:ids.assetId})).status).toBe(404);
 }finally{await f.stop();}
});

it('the real S3 presigner binds upload bytes, checksum, identity and overwrite refusal without network access',async()=>{
 const clientModule='@aws-sdk/client-s3',presignerModule='@aws-sdk/s3-request-presigner';
 const sdk=await import(clientModule),presigner=await import(presignerModule);
 const realSdk={...sdk,...presigner,S3Client:class extends sdk.S3Client{
  constructor(options:Record<string,unknown>){super({...options,credentials:{accessKeyId:'fixture-access-key',secretAccessKey:'fixture-signing-value'}});}
 }} as SocialMediaSdk;
 const issuedAt='2026-10-06T12:00:00.000Z';
 const store=await loadSocialMediaStore({bucket:'callie-fixture-social-assets',region:'us-east-1',sdk:realSdk,now:()=>new Date(issuedAt)});
 const result=await store.presignPut({key:'workspace/asset/1/upload',sha256:'a'.repeat(64),bytes:20,mime:'image/png',uploadId:'fixture-upload',issuedAt});
 const url=new URL(result.url);
 expect(url.origin).toBe('https://callie-fixture-social-assets.s3.us-east-1.amazonaws.com');
 expect(url.pathname).toBe('/workspace/asset/1/upload');
 expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
 expect(url.searchParams.get('X-Amz-Date')).toBe('20261006T120000Z');
 const signed=new Set(url.searchParams.get('X-Amz-SignedHeaders')?.split(';'));
 for(const header of Object.keys(result.headers))expect(signed.has(header),header).toBe(true);
 expect(url.searchParams.has('x-amz-checksum-sha256')).toBe(false);
 expect(url.searchParams.has('x-amz-meta-callie-upload')).toBe(false);
 expect(result.headers['if-none-match']).toBe('*');
 const download=new URL((await store.presignGet('workspace/asset/1/upload')).url);
 expect(download.searchParams.get('response-content-disposition')).toBe('attachment');
});
