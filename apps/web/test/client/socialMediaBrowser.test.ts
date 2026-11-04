// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {socialMediaBrowser,SOCIAL_MEDIA_PENDING_KEY} from '../../src/client/SocialMediaBrowser.ts';
const id='00000000-0000-4000-8000-000000000001';
const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'media-owner',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120_000).toISOString()};
const json=(body:unknown)=>new Response(JSON.stringify(body));
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{locks:{request:async(_key:string,_options:unknown,work:()=>Promise<unknown>)=>work()}});});
afterEach(()=>{localStorage.clear();vi.unstubAllGlobals();});
it('uploads only a signed server grant, omits credentials, and holds one opaque identity after sanitization response loss',async()=>{
 const requests:{path:string;body:Record<string,unknown>}[]=[],external:RequestInit[]=[];
 let lost=true;
 const send=vi.fn<typeof fetch>(async(url,init)=>{
  const path=String(url);if(path==='/browser/session')return json(session);
  if(path.startsWith('https://fixture-social.s3.us-east-1.amazonaws.com/')){external.push(init!);return new Response(null,{status:200});}
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;requests.push({path,body});
  if(path.endsWith('/assets/register'))return json({status:'accepted',replayed:false,result:{assetId:id,uploadId:id}});
  if(path.endsWith('/assets/upload-url'))return json({url:'https://fixture-social.s3.us-east-1.amazonaws.com/opaque?X-Amz-Signature=fixture',headers:{'content-type':'image/png','content-length':'4','x-amz-checksum-sha256':'fixture','x-amz-meta-callie-upload':id,'if-none-match':'*'},expiresAt:new Date(Date.now()+60_000).toISOString()});
  if(path.endsWith('/media/complete')){if(lost)throw Error('Lost after actual acceptance');return json({status:'accepted',replayed:false,result:{assetId:id,version:2,sha256:'a'.repeat(64)}});}
  if(path.endsWith('/media/receipt'))return json({state:'unknown'});
  throw Error('Unexpected route');
 });
 const client=new BrowserClient({fetch:send,storage:localStorage,navigate:vi.fn(),randomUUID:()=>id});await client.refresh();
 const port=socialMediaBrowser(client,()=>{if(!client.isCurrent(client.epoch))throw Error('Scope changed');});
 const file=new File([new Uint8Array([1,2,3,4])],'private-fixture-name.png',{type:'image/png'});Object.defineProperty(file,'arrayBuffer',{value:async()=>new Uint8Array([1,2,3,4]).buffer});
 await expect(port.upload(file)).rejects.toThrow();expect(external).toHaveLength(1);
 expect(external[0]).toMatchObject({method:'PUT',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
 expect(external[0]?.headers).not.toHaveProperty('content-length');expect(external[0]?.headers).not.toHaveProperty('authorization');
 const held=JSON.parse(localStorage.getItem(SOCIAL_MEDIA_PENDING_KEY)!) as {commandId:string;payloadSHA256:string};
 const complete=requests.find(request=>request.path.endsWith('/media/complete'))!;expect(held.commandId).toBe(complete.body['commandId']);
 expect(localStorage.getItem(SOCIAL_MEDIA_PENDING_KEY)).not.toContain('private-fixture-name');expect(localStorage.getItem(SOCIAL_MEDIA_PENDING_KEY)).not.toContain('https:');
 await expect(port.reconcile()).resolves.toBe('unknown');expect(requests.at(-1)?.body).toEqual({kind:'complete',commandId:held.commandId,payloadSHA256:held.payloadSHA256});
 lost=false;await expect(port.upload(file)).rejects.toThrow('Reconcile');expect(requests.filter(request=>request.path.endsWith('/assets/register'))).toHaveLength(1);expect(requests.filter(request=>request.path.endsWith('/media/complete'))).toHaveLength(1);
 client.invalidate();expect(localStorage.getItem(SOCIAL_MEDIA_PENDING_KEY)).toBeNull();client.dispose();
});
it('withholds upload grants when current client authority is lost',async()=>{
 const send=vi.fn<typeof fetch>(async()=>json(session));const client=new BrowserClient({fetch:send,storage:localStorage,navigate:vi.fn(),randomUUID:()=>id});await client.refresh();
 let checked=false;await expect(client.uploadSocialAsset({assetId:id,uploadId:id},new File(['x'],'fixture.png',{type:'image/png'}),()=>{checked=true;throw Error('Client replaced');})).rejects.toThrow();
 expect(checked).toBe(true);expect(send.mock.calls.every(([url])=>url==='/browser/session')).toBe(true);client.dispose();
});
