import {randomUUID} from 'node:crypto';
import {chromium,type Browser,type BrowserServer} from 'playwright';
import {createPrivatePublisherLaunch} from './publisherNative.ts';
import {attestPublisherSandbox} from './publisherSandbox.ts';
import {assertPublisherDebugDisabled} from './publisherConfig.ts';
import {startPublisherRelay,type PublisherRelayHandle} from './publisherRelay.ts';

export interface PublisherBrowserHostOptions {token:Buffer;executablePath?:string;host?:string;port?:number}
export interface PublisherBrowserHostHandle {
 address:{host:string;port:number};
 closed:Promise<void>;
 close():Promise<void>;
}
/** Browser-only process: no database, application/session-encryption or provider
 * credentials. Raw Playwright binds literal loopback and is never returned/logged. */
export async function startPublisherBrowserHost(options:PublisherBrowserHostOptions):Promise<PublisherBrowserHostHandle>{
 assertPublisherDebugDisabled(process.env);
 if(options.token.length!==32)throw new Error('publisher_control_token_invalid');
 if(process.platform!=='linux'||!process.getuid||process.getuid()===0)throw new Error('publisher_host_linux_nonroot_required');
 const launch=await createPrivatePublisherLaunch(options.executablePath);
 let native:BrowserServer|undefined,browser:Browser|undefined,relay:PublisherRelayHandle|undefined;
 let attested=false,closing:Promise<void>|undefined;
 const finished=Promise.withResolvers<void>();
 const close=()=>{
  if(!closing){
   closing=(async()=>{
    attested=false;
    const force=setTimeout(()=>{void native?.kill().catch(()=>{});},5000);force.unref();
    let failed=false;
    try{
     try{await relay?.close();}catch{failed=true;}
     try{await browser?.close();}catch{failed=true;}
     try{await native?.close();}catch{failed=true;}
     try{await launch.close();}catch{failed=true;}
    }finally{clearTimeout(force);finished.resolve();}
    if(failed)throw new Error('publisher_host_shutdown_failed');
   })();
  }
  return closing;
 };
 try{
  native=await chromium.launchServer({...launch.options,host:'127.0.0.1',port:0,wsPath:randomUUID(),handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});
  const endpoint=native.wsEndpoint(),url=new URL(endpoint);
  if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash)throw new Error('publisher_native_endpoint_invalid');
  native.process().once('exit',()=>{attested=false;void close().catch(()=>{});});
  browser=await chromium.connect(endpoint,{timeout:10000});
  browser.once('disconnected',()=>{attested=false;void close().catch(()=>{});});
  await attestPublisherSandbox(browser,'linux-host');
  if(closing||!browser.isConnected()||native.process().exitCode!==null||native.process().killed)throw new Error('publisher_host_unavailable');
  attested=true;
  relay=await startPublisherRelay({token:options.token,nativeEndpoint:endpoint,healthy:()=>attested&&!closing&&browser?.isConnected()===true&&native?.process().exitCode===null&&native?.process().killed===false,host:options.host??'0.0.0.0',port:options.port??8080});
  if(closing||!browser.isConnected()){await relay.close();throw new Error('publisher_host_unavailable');}
  return {address:relay.address,closed:finished.promise,close};
 }catch{
  await close().catch(()=>{});
  throw new Error('publisher_host_startup_failed');
 }
}
