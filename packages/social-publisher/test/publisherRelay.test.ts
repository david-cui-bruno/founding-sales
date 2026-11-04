import {afterEach,describe,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {request,type IncomingHttpHeaders,type IncomingMessage} from 'node:http';
import {createConnection} from 'node:net';
import WebSocket,{WebSocketServer,type RawData} from 'ws';
import {startPublisherRelay} from '../src/publisherRelay.ts';

const path='/social/publisher-runtime/browser';
const limit=12*1024*1024;
const resources:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of resources.splice(0).reverse())await close();});
function closed(peer:WebSocket):Promise<void>{
 if(peer.readyState===WebSocket.CLOSED)return Promise.resolve();
 const result=Promise.withResolvers<void>();peer.once('close',()=>result.resolve());return result.promise;
}
function message(peer:WebSocket):Promise<{data:RawData;binary:boolean}>{
 const result=Promise.withResolvers<{data:RawData;binary:boolean}>();
 peer.once('message',(data,binary)=>result.resolve({data,binary}));return result.promise;
}
async function harness(options:{nativeAutoPong?:boolean;nativeUserAgent?:string}={}){
 const token=randomBytes(32),nativeRequests:IncomingHttpHeaders[]=[];
 const native=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:32*1024*1024,perMessageDeflate:false,autoPong:options.nativeAutoPong??true,
  verifyClient:(info:{req:IncomingMessage})=>{
   nativeRequests.push(info.req.headers);
   return options.nativeUserAgent===undefined||info.req.headers['user-agent']===options.nativeUserAgent;
  }});
 await once(native,'listening');
 resources.push(async()=>{
  const done=Promise.withResolvers<void>();
  for(const peer of native.clients)peer.terminate();
  native.close(()=>done.resolve());await done.promise;
 });
 const nativeAddress=native.address();
 if(typeof nativeAddress==='string'||!nativeAddress)throw new Error('missing_native_address');
 let healthy=true,throwHealth=false,connections=0;
 native.on('connection',peer=>{connections++;peer.on('error',()=>{});});
 const relay=await startPublisherRelay({token,nativeEndpoint:`ws://127.0.0.1:${nativeAddress.port}/owned-native`,healthy:()=>{if(throwHealth)throw new Error('private details');return healthy;},host:'127.0.0.1',port:0});
 resources.push(relay.close);
 const endpoint=`ws://127.0.0.1:${relay.address.port}${path}`;
 const authorization=`Bearer ${token.toString('base64')}`;
 const nextNative=()=>{
  const result=Promise.withResolvers<WebSocket>();native.once('connection',peer=>result.resolve(peer));return result.promise;
 };
 const open=async(clientOptions:{autoPong?:boolean;headers?:Record<string,string>}={})=>{
  const upstream=nextNative();
  const client=new WebSocket(endpoint,{...clientOptions,headers:{Authorization:authorization,...clientOptions.headers},perMessageDeflate:false});
  client.on('error',()=>{});resources.push(async()=>{client.terminate();await closed(client);});
  await once(client,'open');return {client,upstream:await upstream};
 };
 const http=(url:string,headers?:string[],method='GET')=>{
  const result=Promise.withResolvers<{status:number;body:string}>();
  const req=request({host:'127.0.0.1',port:relay.address.port,path:url,method,headers},response=>{
   let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});
   response.on('end',()=>result.resolve({status:response.statusCode??0,body}));response.on('error',result.reject);
  });
  req.on('upgrade',(_response,socket)=>{socket.destroy();result.reject(new Error('unexpected_upgrade'));});
  req.on('error',result.reject);req.end();return result.promise;
 };
 const upgrade=(url=path,extra:string[]=[],auth:string[]=['Authorization',authorization])=>http(url,[
  'Host','127.0.0.1','Connection','Upgrade','Upgrade','websocket','Sec-WebSocket-Version','13',
  'Sec-WebSocket-Key',randomBytes(16).toString('base64'),...auth,...extra,
 ]);
 return {relay,native,nativeRequests,open,http,upgrade,authorization,token,nextNative,get connections(){return connections;},
  revoke:()=>{healthy=false;},throwHealth:()=>{throwHealth=true;}};
}

describe('authenticated publisher WebSocket relay with actual local transport',()=>{
 it('rejects missing, wrong, duplicate, combined and noncanonical tokens before native connection',async()=>{
  const h=await harness();
  const cases=[[],['Authorization',`Bearer ${randomBytes(32).toString('base64')}`],
   ['Authorization',h.authorization,'authorization',h.authorization],
   ['Authorization',`${h.authorization}, ${h.authorization}`],
   ['Authorization',`Bearer ${h.token.toString('base64').replace(/=$/u,'')}`],
   ['Authorization',`Basic ${h.token.toString('base64')}`],['Authorization','Bearer invalid']];
  for(const auth of cases)expect(await h.upgrade(path,[],auth)).toEqual({status:401,body:''});
  expect(h.connections).toBe(0);
 });
 it('rejects ambiguous, oversized and control-bearing user agents before contacting native transport',async()=>{
  const h=await harness();
  for(const headers of [['User-Agent','one','user-agent','two'],['User-Agent','a'.repeat(513)],['User-Agent','a\tb']])
   expect((await h.upgrade(path,headers)).status).toBe(400);
  expect(h.nativeRequests).toHaveLength(0);
 });
 it('preserves native user-agent admission while withholding credentials and launch/proxy headers',async()=>{
  const userAgent='Playwright/1.64.0 (fixture transport)';
  const h=await harness({nativeUserAgent:userAgent});
  const {client,upstream}=await h.open({headers:{'User-Agent':userAgent,Cookie:'private=cookie',
   'x-playwright-proxy':'private-proxy','x-playwright-launch-options':'private-launch'}});
  expect(h.nativeRequests[0]?.['user-agent']).toBe(userAgent);
  for(const name of ['authorization','cookie','origin','x-playwright-proxy','x-playwright-launch-options'])
   expect(h.nativeRequests[0]?.[name]).toBeUndefined();
  const delivered=message(upstream);client.send('admitted transport');expect((await delivered).data.toString()).toBe('admitted transport');
  const rejected=new WebSocket(`ws://127.0.0.1:${h.relay.address.port}${path}`,
   {headers:{Authorization:h.authorization,'User-Agent':'Playwright/0.0.0 (incompatible fixture)'}});
  rejected.on('error',()=>{});await closed(rejected);
  expect(h.nativeRequests).toHaveLength(2);expect(h.nativeRequests[1]?.['user-agent']).toContain('0.0.0');
  expect(h.connections).toBe(1);
 });
 it('requires the exact path, server-only origin/protocol policy and a well-formed upgrade',async()=>{
  const h=await harness();
  for(const url of [`${path}?token=private`,`${path}?`,`${path}/`,`${path}/extra`,'/other','/social/publisher-runtime/%62rowser'])
   expect(await h.upgrade(url)).toEqual({status:404,body:''});
  for(const extra of [['Origin','https://fixture.invalid'],['Sec-WebSocket-Protocol','arbitrary'],
   ['Sec-WebSocket-Version','12'],['Sec-WebSocket-Key','invalid'],['Upgrade','other'],['Connection','keep-alive']])
   expect((await h.upgrade(path,extra)).status).toBe(400);
  expect(h.connections).toBe(0);
 });
 it('forwards parsed fragmented text and binary messages in both directions without changing message type',async()=>{
  const h=await harness();const {client,upstream}=await h.open();
  const received=message(upstream);
  client.send('first ',{binary:false,fin:false});client.send('second',{binary:false,fin:true});
  const text=await received;expect(text.binary).toBe(false);expect(text.data.toString()).toBe('first second');
  const bytes=Buffer.from([0,255,128,13,10,0,42]);
  const incoming=message(client);upstream.send(bytes,{binary:true});
  expect(await incoming).toEqual({data:bytes,binary:true});
  const reverse=message(upstream);client.send(bytes,{binary:true});expect(await reverse).toEqual({data:bytes,binary:true});
  const nativeText=message(client);upstream.send('native text',{binary:false});
  const reply=await nativeText;expect(reply.binary).toBe(false);expect(reply.data.toString()).toBe('native text');
 });
 it('retains messages sent immediately after authentication while the native handshake completes',async()=>{
  const h=await harness();const upstream=h.nextNative();
  const client=new WebSocket(`ws://127.0.0.1:${h.relay.address.port}${path}`,{headers:{Authorization:h.authorization}});
  client.on('error',()=>{});resources.push(async()=>{client.terminate();await closed(client);});
  // Install the native observer synchronously on connection, before any message can arrive.
  const received=Promise.withResolvers<string>();h.native.once('connection',peer=>peer.once('message',data=>received.resolve(data.toString())));
  client.once('open',()=>client.send('early owned message'));
  await upstream;expect(await received.promise).toBe('early owned message');
 });
 it('admits six authenticated clients only and releases capacity after a downstream disconnect',async()=>{
  const h=await harness();const first=await h.open(),second=await h.open();
  for(let i=0;i<4;i++)await h.open();
  expect((await h.upgrade()).status).toBe(503);expect(h.connections).toBe(6);
  const nativeClosed=closed(first.upstream);first.client.close();await nativeClosed;
  const replacement=await h.open();expect(h.connections).toBe(7);
  expect((await h.upgrade()).status).toBe(503);expect(h.connections).toBe(7);
  const incoming=message(second.upstream);second.client.send('separate context transport');
  expect((await incoming).data.toString()).toBe('separate context transport');
  const replacementNativeClosed=closed(replacement.upstream);replacement.client.terminate();await replacementNativeClosed;
 });
 it('roundtrips a full 12MiB binary message unchanged in both directions',async()=>{
  const h=await harness();const {client,upstream}=await h.open();
  const payload=Buffer.alloc(limit,19);
  for(const {source,destination} of [{source:client,destination:upstream},{source:upstream,destination:client}]){
   const received=message(destination);source.send(payload);
   const accepted=await received;expect(accepted.binary).toBe(true);
   if(!Buffer.isBuffer(accepted.data))throw new Error('expected_binary_buffer');
   expect(accepted.data.length).toBe(limit);
   // Compare every byte natively: deep equality enumerates millions of Buffer
   // entries and can starve transport callbacks before the close assertions run.
   expect(accepted.data.equals(payload)).toBe(true);
  }
 });
 it.each(['downstream','native'])('promptly closes both peers and releases a full relay slot on %s overflow',async side=>{
  const h=await harness();const first=await h.open();
  for(let i=0;i<5;i++)await h.open();
  expect((await h.upgrade()).status).toBe(503);expect(h.connections).toBe(6);
  const source=side==='downstream'?first.client:first.upstream;
  const destination=side==='downstream'?first.upstream:first.client;
  let forwarded=false;destination.on('message',()=>{forwarded=true;});
  // Observe both actual closes before sending; neither an error event nor a
  // teardown helper is evidence that the relay rejected and released the pair.
  const clientClosed=closed(first.client),nativeClosed=closed(first.upstream);
  source.send(Buffer.alloc(limit+1));
  await Promise.all([clientClosed,nativeClosed]);
  expect(first.client.readyState).toBe(WebSocket.CLOSED);
  expect(first.upstream.readyState).toBe(WebSocket.CLOSED);
  expect(forwarded).toBe(false);expect(h.native.clients.size).toBe(5);
  const replacement=await h.open();expect(h.connections).toBe(7);
  expect((await h.upgrade()).status).toBe(503);expect(h.native.clients.size).toBe(6);
  const received=message(replacement.upstream);replacement.client.send('released slot');
  expect((await received).data.toString()).toBe('released slot');
 },5000);
 it('tears down the other side on native clean closure and abrupt socket errors',async()=>{
  const h=await harness();const first=await h.open();
  const firstClosed=closed(first.client);first.upstream.close(1000);await firstClosed;
  const second=await h.open();const secondClosed=closed(second.client);second.upstream.terminate();await secondClosed;
  const third=await h.open();const thirdClosed=closed(third.upstream);third.client.terminate();await thirdClosed;
 });
 it('exposes current attestation health only at GET /health and revokes existing connections',async()=>{
  const h=await harness();expect(await h.http('/health')).toEqual({status:200,body:'ok\n'});
  for(const url of ['/health?detail=secret','/health/','/',path])expect((await h.http(url)).status).toBe(404);
  expect((await h.http('/health',undefined,'POST')).status).toBe(404);
  const {client,upstream}=await h.open();const clientClosed=closed(client),nativeClosed=closed(upstream);
  h.revoke();await Promise.all([clientClosed,nativeClosed]);
  expect(await h.http('/health')).toEqual({status:503,body:'unavailable\n'});
  expect((await h.upgrade()).status).toBe(503);expect(h.connections).toBe(1);
 });
 it('fails closed when the health callback throws without disclosing its exception',async()=>{
  const h=await harness();const {client,upstream}=await h.open();
  const clientClosed=closed(client),nativeClosed=closed(upstream);h.throwHealth();
  expect(await h.http('/health')).toEqual({status:503,body:'unavailable\n'});
  await Promise.all([clientClosed,nativeClosed]);expect((await h.upgrade()).status).toBe(503);
 });
 it('pings both peers for idle ALB connections and observes their automatic pongs',async()=>{
  const h=await harness();const {client,upstream}=await h.open();
  await Promise.all([once(client,'ping'),once(upstream,'ping')]);
  await Promise.all([once(client,'ping'),once(upstream,'ping')]);
  const received=message(upstream);client.send('still live after heartbeat');
  expect((await received).data.toString()).toBe('still live after heartbeat');
 },25000);
 it.each(['downstream','native'])('disconnects both sockets when %s stops answering pings',async side=>{
  const h=await harness({nativeAutoPong:side!=='native'});
  const {client,upstream}=await h.open({autoPong:side!=='downstream'});
  await Promise.all([closed(client),closed(upstream)]);
  expect((await h.http('/health')).status).toBe(200);
 },25000);
 it('bounds a stalled send and closes a backpressured transport instead of retaining its queue forever',async()=>{
  const h=await harness();const {client,upstream}=await h.open();upstream.pause();
  const clientClosed=closed(client),nativeClosed=closed(upstream);
  const chunk=Buffer.alloc(1024*1024,3);
  for(let i=0;i<32;i++)client.send(chunk,error=>{if(error)client.terminate();});
  await clientClosed;upstream.resume();await nativeClosed;
  const replacement=await h.open();expect(replacement.client.readyState).toBe(WebSocket.OPEN);
 },25000);
 it('shutdown closes active and partial sockets, frees the listener and is idempotent',async()=>{
  const h=await harness();const first=await h.open(),second=await h.open();
  const partial=createConnection({host:'127.0.0.1',port:h.relay.address.port});
  const partialErrors:string[]=[];partial.on('error',(error:NodeJS.ErrnoException)=>{partialErrors.push(error.code??'unknown');});
  await once(partial,'connect');partial.write('GET /health HTTP/1.1\r\n');
  // Force-closing an incomplete HTTP request may reset TCP; still wait for the
  // actual close rather than events.once(), which rejects before close on error.
  const partialClose=Promise.withResolvers<void>();partial.once('close',()=>partialClose.resolve());const partialClosed=partialClose.promise;
  const allClosed=[closed(first.client),closed(first.upstream),closed(second.client),closed(second.upstream)];
  const closing=h.relay.close();expect(h.relay.close()).toBe(closing);
  await Promise.all([closing,partialClosed,...allClosed]);expect(h.native.clients.size).toBe(0);
  expect(partial.destroyed).toBe(true);expect(partialErrors.every(code=>code==='ECONNRESET')).toBe(true);
  expect(h.token.some(byte=>byte!==0)).toBe(true); // Relay owns and erases a copy, not the caller's key.
 });
 it('closes downstream when a validated native listener is no longer available',async()=>{
  const h=await harness();const stopped=Promise.withResolvers<void>();h.native.close(()=>stopped.resolve());await stopped.promise;
  const client=new WebSocket(`ws://127.0.0.1:${h.relay.address.port}${path}`,{headers:{Authorization:h.authorization}});
  client.on('error',()=>{});await closed(client);
 });
 it('reports a sanitized listener failure rather than leaking a native URL or keeping its health timer',async()=>{
  const h=await harness();
  await expect(startPublisherRelay({token:randomBytes(32),nativeEndpoint:'ws://127.0.0.1:1/private-native-path',
   healthy:()=>true,host:'127.0.0.1',port:h.relay.address.port})).rejects.toThrow('publisher_relay_listen_failed');
  expect((await h.http('/health')).status).toBe(200);
 });
 it('rejects invalid token length and nonliteral-loopback or credential-bearing native endpoints without listening',async()=>{
  const base={token:randomBytes(32),healthy:()=>true,host:'127.0.0.1',port:0};
  for(const nativeEndpoint of ['https://127.0.0.1/native','wss://127.0.0.1/native','ws://example.invalid/native',
   'ws://localhost/native','ws://0.0.0.0/native','ws://169.254.169.254/native','ws://user:secret@127.0.0.1/native',
   'ws://127.0.0.1/native?secret=private','ws://127.0.0.1/native#private','not a URL'])
   await expect(startPublisherRelay({...base,nativeEndpoint})).rejects.toThrow('publisher_native_endpoint_invalid');
  await expect(startPublisherRelay({...base,token:Buffer.alloc(31),nativeEndpoint:'ws://127.0.0.1/native'})).rejects.toThrow('publisher_relay_token_invalid');
 });
});
