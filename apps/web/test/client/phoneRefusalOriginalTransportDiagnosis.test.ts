import {IncomingMessage,ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import {expect,it,vi} from 'vitest';
import {z} from 'zod';
import {PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {createBrowserHostHandler} from '../../src/server/host.ts';
import {observeRefusalResponseBytes} from '../support/phoneRefusalOriginalApp.ts';
const mocked=vi.hoisted(()=>({browser:vi.fn()}));
vi.mock('../../src/server/browser.ts',()=>({createBrowserHandler:()=>mocked.browser}));
vi.mock('../support/phoneDiscoveryApp.ts',()=>({}));
const id='10000000-0000-4000-8000-000000000001',body={error:'browser_request_refused'};

it('byte observer: forwards exact write/end args, callbacks, receiver and return values once while proving exact split bytes',async()=>{
 const socket=new Socket(),request=new IncomingMessage(socket),response=new ServerResponse(request),callback=vi.fn();
 const first=Buffer.from('{"error":'),last='"browser_request_refused"}',snapshot=Buffer.from(first);
 const write=vi.spyOn(response,'write').mockImplementation(function(this:ServerResponse){expect(this).toBe(response);return false;});
 const end=vi.spyOn(response,'end').mockImplementation(function(this:ServerResponse){expect(this).toBe(response);return response;});
 try{
  response.statusCode=409;const receipt=observeRefusalResponseBytes(response,3);
  expect(response.write(first,callback)).toBe(false);expect(response.end(last,'utf8',callback)).toBe(response);
  expect(write).toHaveBeenCalledExactlyOnceWith(first,callback);expect(end).toHaveBeenCalledExactlyOnceWith(last,'utf8',callback);expect(first).toEqual(snapshot);expect(callback).not.toHaveBeenCalled();
  Object.defineProperty(response,'writableFinished',{value:true});response.emit('finish');
  expect(await receipt).toMatchObject({ordinal:3,status:409,finished:true,length:35,overflow:false,exactBytes:true,hashMatches:true,noOriginal:true});
 }finally{write.mockRestore();end.mockRestore();request.destroy();socket.destroy();}
});

it('byte observer: stops capture and refuses overflow without truncating or suppressing original writes',async()=>{
 const socket=new Socket(),request=new IncomingMessage(socket),response=new ServerResponse(request),chunk=Buffer.alloc(36,120);
 const write=vi.spyOn(response,'write').mockReturnValue(true),end=vi.spyOn(response,'end').mockReturnValue(response);
 try{
  const receipt=observeRefusalResponseBytes(response,3);response.write(chunk);response.end('tail');response.emit('finish');
  expect(write).toHaveBeenCalledExactlyOnceWith(chunk);expect(end).toHaveBeenCalledExactlyOnceWith('tail');
  expect(await receipt).toMatchObject({length:40,overflow:true,exactBytes:false,hashMatches:false,noOriginal:false});
  expect(JSON.stringify(await receipt)).not.toContain('xxxx');expect(chunk).toEqual(Buffer.alloc(36,120));
 }finally{write.mockRestore();end.mockRestore();request.destroy();socket.destroy();}
});

it('byte observer: preserves callback-only end and refuses incomplete close',async()=>{
 const socket=new Socket(),request=new IncomingMessage(socket),response=new ServerResponse(request),callback=vi.fn();
 const end=vi.spyOn(response,'end').mockReturnValue(response);
 try{
  const receipt=observeRefusalResponseBytes(response,3);response.end(callback);response.emit('close');
  expect(end).toHaveBeenCalledExactlyOnceWith(callback);expect(callback).not.toHaveBeenCalled();
  expect(await receipt).toMatchObject({finished:false,length:0,overflow:false,exactBytes:false,hashMatches:false});
 }finally{end.mockRestore();request.destroy();socket.destroy();}
});

it('byte observer: observation errors cannot suppress original end arguments or replace its exception',async()=>{
 const socket=new Socket(),request=new IncomingMessage(socket),response=new ServerResponse(request),failure=Error('original failure');
 const end=vi.spyOn(response,'end').mockImplementation(()=>{throw failure;});
 try{
  const receipt=observeRefusalResponseBytes(response,3);
  expect(()=>Reflect.apply(response.end,response,['x','invalid-encoding'])).toThrow(failure);
  expect(end).toHaveBeenCalledExactlyOnceWith('x','invalid-encoding');response.emit('close');
  expect(await receipt).toMatchObject({finished:false,overflow:true,exactBytes:false,hashMatches:false});
 }finally{end.mockRestore();request.destroy();socket.destroy();}
});

it('diagnosis: real BrowserClient invalidates on409 without consuming or explicitly cancelling the native response body',async()=>{
 const cancel=vi.fn(),bytes=new TextEncoder().encode(JSON.stringify(body));
 const response=new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();},cancel}),{status:409,headers:{'content-type':'application/json','content-length':String(bytes.byteLength)}});
 const read=vi.spyOn(response,'json'),calls:{path:string;signal:AbortSignal|null|undefined}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{
  calls.push({path:String(url),signal:init?.signal});
  if(String(url)==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'x'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()});
  expect(String(url)).toBe(`/browser/api${PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH}`);return response;
 };
 const client=new BrowserClient({fetch:fetcher,storage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},navigate:()=>{throw Error('No navigation allowed');},randomUUID:()=>id});
 try{
  await client.refresh();const epoch=client.epoch;
  await expect(client.request(PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH,z.unknown(),{})).rejects.toMatchObject({reason:'refused'});
  expect(client.epoch).toBeGreaterThan(epoch);expect(client.current).toBeNull();
  expect(read).not.toHaveBeenCalled();expect(response.bodyUsed).toBe(false);expect(cancel).not.toHaveBeenCalled();
  expect(calls.every(call=>call.signal===undefined)).toBe(true);
  client.dispose(); // Corresponding unmount/identity cleanup does not cancel fetch.
  expect(cancel).not.toHaveBeenCalled();expect(response.bodyUsed).toBe(false);
  expect(await response.json()).toEqual(body);
 }finally{client.dispose();}
});

it('diagnosis: actual host transport frames and ends the complete fixed409 body without a listener or network',async()=>{
 const origin='https://localhost:58207',payload=Buffer.from('{}');
 mocked.browser.mockResolvedValue({status:409,body,headers:{}});
 const socket=new Socket(),request=new IncomingMessage(socket),response=new ServerResponse(request);
 request.method='POST';request.url=`/browser/api${PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH}`;
 request.rawHeaders=['Host',new URL(origin).host,'Content-Type','application/json','Origin',origin,'Content-Length',String(payload.byteLength)];
 request.complete=true;
 let finish:(value:unknown)=>void=()=>{throw Error('end observation not installed');};
 const ended=new Promise<unknown>(resolve=>{finish=resolve;});
 const end=vi.spyOn(response,'end').mockImplementation((chunk:unknown)=>{finish(chunk);return response;});
 try{
  const handler=createBrowserHostHandler({runtime:{origin,clientVersion:'1.4.0',cookieKey:Buffer.alloc(32),withRequest:async()=>{throw Error('Mock adapter only, no auth/DB');}},assets:new Map()});
  handler(request,response);request.push(payload);request.push(null);
  const emitted=await ended;
  expect(mocked.browser).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({method:'POST',path:request.url,body:{}}));
  expect(response.statusCode).toBe(409);expect(end).toHaveBeenCalledTimes(1);expect(Buffer.isBuffer(emitted)).toBe(true);
  expect(emitted).toEqual(Buffer.from(JSON.stringify(body)));expect(response.getHeader('content-length')).toBe(Buffer.byteLength(JSON.stringify(body)));
  expect(response.getHeader('content-type')).toBe('application/json; charset=utf-8');
 }finally{end.mockRestore();request.destroy();socket.destroy();}
});
