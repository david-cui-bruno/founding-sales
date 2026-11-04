import {timingSafeEqual} from 'node:crypto';
import {createServer,type IncomingMessage} from 'node:http';
import type {Socket} from 'node:net';
import type {Duplex} from 'node:stream';
import WebSocket,{WebSocketServer,type RawData} from 'ws';

const path='/social/publisher-runtime/browser';
const maxPayload=12*1024*1024;
const heartbeatMs=10_000;
const maxQueuedMessages=128;

export interface PublisherRelayOptions {
 token:Buffer;
 nativeEndpoint:string;
 healthy:()=>boolean;
 host:string;
 port:number;
}
export interface PublisherRelayHandle {
 address:{host:string;port:number};
 close():Promise<void>;
}

function nativeURL(value:string):string {
 let url:URL;
 try{url=new URL(value);}catch{throw new Error('publisher_native_endpoint_invalid');}
 // Literal loopback only: do not trust DNS (including a configurable localhost resolver).
 if(url.protocol!=='ws:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)
  throw new Error('publisher_native_endpoint_invalid');
 return url.href;
}
function header(request:IncomingMessage,name:string):string|undefined {
 let value:string|undefined;
 for(let i=0;i<request.rawHeaders.length;i+=2){
  if(request.rawHeaders[i]?.toLowerCase()!==name)continue;
  if(value!==undefined)return undefined;
  value=request.rawHeaders[i+1];
 }
 return value;
}
function authorized(request:IncomingMessage,token:Buffer):boolean {
 const value=header(request,'authorization');
 if(!value||!/^Bearer [A-Za-z0-9+/]{43}=$/u.test(value))return false;
 const encoded=value.slice(7),decoded=Buffer.from(encoded,'base64');
 return decoded.length===32&&decoded.toString('base64')===encoded&&timingSafeEqual(decoded,token);
}
function validUpgrade(request:IncomingMessage):boolean {
 const key=header(request,'sec-websocket-key');
 return request.method==='GET'&&request.httpVersion==='1.1'&&
  header(request,'upgrade')?.toLowerCase()==='websocket'&&
  header(request,'connection')?.toLowerCase().split(',').map(value=>value.trim()).includes('upgrade')===true&&
  header(request,'sec-websocket-version')==='13'&&key!==undefined&&
  /^[A-Za-z0-9+/]{22}==$/u.test(key)&&Buffer.from(key,'base64').toString('base64')===key&&
  !request.rawHeaders.some((value,index)=>index%2===0&&['origin','sec-websocket-protocol'].includes(value.toLowerCase()));
}
function validUserAgent(value:string):boolean {
 if(value.length===0||value.length>512)return false;
 for(let i=0;i<value.length;i++){
  const code=value.charCodeAt(i);
  if(code<32||(code>=127&&code<=159))return false;
 }
 return true;
}


/** Authenticated, parsed WebSocket transport; owns no browser or application credentials. */
export async function startPublisherRelay(options:PublisherRelayOptions):Promise<PublisherRelayHandle> {
 if(options.token.length!==32)throw new Error('publisher_relay_token_invalid');
 const endpoint=nativeURL(options.nativeEndpoint),token=Buffer.from(options.token);
 const sockets=new Set<Socket>(),sessions=new Set<()=>void>();
 let stopping=false,closing:Promise<void>|undefined;
 const healthy=()=>{try{return !stopping&&options.healthy();}catch{return false;}};
 const server=createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:5000},(request,response)=>{
  const status=request.method==='GET'&&request.url==='/health'?(healthy()?200:503):404;
  response.writeHead(status,{'content-type':'text/plain','connection':'close','cache-control':'no-store'});
  response.end(status===200?'ok\n':status===503?'unavailable\n':'not found\n');
  if(!healthy())for(const dispose of sessions)dispose();
 });
 server.maxRequestsPerSocket=16;
 server.maxConnections=16;
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.on('clientError',(_error,socket)=>socket.destroy());
 const reject=(socket:Duplex,status:number)=>{
  socket.end(`HTTP/1.1 ${status} ${status===401?'Unauthorized':status===404?'Not Found':status===503?'Service Unavailable':'Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const timer=setTimeout(()=>socket.destroy(),500);timer.unref();socket.once('close',()=>clearTimeout(timer));
 };
 const websocketServer=new WebSocketServer({noServer:true,maxPayload,perMessageDeflate:false,clientTracking:false});
 server.on('upgrade',(request,socket,head)=>{
  // No URL parsing/normalization: query strings, suffixes and alternate encodings are not this endpoint.
  if(request.url!==path){reject(socket,404);return;}
  if(!authorized(request,token)){reject(socket,401);return;}
  if(!validUpgrade(request)){reject(socket,400);return;}
  const userAgent=header(request,'user-agent');
  const hasUserAgent=request.rawHeaders.some((value,index)=>index%2===0&&value.toLowerCase()==='user-agent');
  if(hasUserAgent&&(userAgent===undefined||!validUserAgent(userAgent))){
   reject(socket,400);return;
  }
  if(!healthy()||sessions.size>=6){reject(socket,503);return;}
  websocketServer.handleUpgrade(request,socket,head,downstream=>{
   downstream.pause();
   let disposed=false;
   // Only the native Playwright version guard's User-Agent crosses the trust boundary.
   const upstream=new WebSocket(endpoint,{maxPayload,perMessageDeflate:false,handshakeTimeout:5000,followRedirects:false,
    ...(userAgent===undefined?{}:{headers:{'User-Agent':userAgent}})});
   const dispose=()=>{
    if(disposed)return;
    disposed=true;sessions.delete(dispose);clearInterval(heartbeat);
    downstream.terminate();upstream.terminate();
   };
   sessions.add(dispose);
   const alive=new Map<WebSocket,boolean>([[downstream,true],[upstream,true]]);
   const sendingSince=new Map<WebSocket,number>();
   const heartbeat=setInterval(()=>{
    if(!healthy()){dispose();return;}
    for(const peer of [downstream,upstream]){
     const started=sendingSince.get(peer);
     if(started!==undefined&&Date.now()-started>=heartbeatMs){dispose();return;}
     if(peer.readyState!==WebSocket.OPEN)continue;
     if(!alive.get(peer)){dispose();return;}
     alive.set(peer,false);
     peer.ping(undefined,undefined,error=>{if(error)dispose();});
    }
   },heartbeatMs);heartbeat.unref();
   for(const peer of [downstream,upstream]){
    peer.on('pong',()=>alive.set(peer,true));
    peer.on('close',dispose);peer.on('error',dispose);
   }
   // Each direction has a byte/count bounded queue and exactly one outstanding send.
   // Pausing the source bounds TCP input as well as the parsed-message queue.
   const forward=(source:WebSocket,destination:WebSocket)=>{
    const queue:Array<{data:RawData;binary:boolean;bytes:number}>=[];
    let queuedBytes=0,sending=false;
    const pump=()=>{
     if(disposed||sending||destination.readyState!==WebSocket.OPEN)return;
     const message=queue.shift();
     if(!message){source.resume();return;}
     sending=true;
     if(destination.bufferedAmount+message.bytes>maxPayload){dispose();return;}
     sendingSince.set(destination,Date.now());
     destination.send(message.data,{binary:message.binary,compress:false},error=>{
      sendingSince.delete(destination);
      sending=false;queuedBytes-=message.bytes;
      if(error){dispose();return;}
      pump();
     });
    };
    source.on('message',(data,binary)=>{
     if(disposed)return;
     const bytes=Array.isArray(data)?data.reduce((sum,part)=>sum+part.length,0):data instanceof ArrayBuffer?data.byteLength:data.length;
     if(bytes>maxPayload||queuedBytes+bytes>maxPayload||queue.length>=maxQueuedMessages){dispose();return;}
     queuedBytes+=bytes;queue.push({data,binary,bytes});source.pause();pump();
    });
    destination.on('open',pump);
   };
   forward(downstream,upstream);forward(upstream,downstream);
   upstream.once('open',()=>{if(!healthy())dispose();else downstream.resume();});
   if(!healthy())dispose();
  });
 });
 const healthTimer=setInterval(()=>{if(!healthy())for(const dispose of sessions)dispose();},250);healthTimer.unref();
 try{
  const listening=Promise.withResolvers<void>();
  const onError=(error:Error)=>{server.off('listening',onListen);listening.reject(error);};
  const onListen=()=>{server.off('error',onError);listening.resolve();};
  server.once('error',onError);server.once('listening',onListen);server.listen(options.port,options.host);
  await listening.promise;
 }catch{
  clearInterval(healthTimer);token.fill(0);websocketServer.close();
  throw new Error('publisher_relay_listen_failed');
 }
 server.on('error',()=>{for(const dispose of sessions)dispose();});
 const address=server.address();
 if(!address||typeof address==='string')throw new Error('publisher_relay_listen_failed');
 return {address:{host:address.address,port:address.port},close(){
  if(!closing){
   const closed=Promise.withResolvers<void>();closing=closed.promise;
   stopping=true;clearInterval(healthTimer);
   for(const dispose of sessions)dispose();
   for(const socket of sockets)socket.destroy();
   websocketServer.close();token.fill(0);
   server.close(()=>closed.resolve());server.closeAllConnections();
  }
  return closing;
 }};
}
