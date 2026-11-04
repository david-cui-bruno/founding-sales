import {it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {chromium,type Browser,type BrowserContext} from 'playwright';
import {startPublisherBrowserHost,type PublisherBrowserHostHandle} from '../src/publisherHost.ts';
import {attestPublisherSandbox} from '../src/publisherSandbox.ts';

/** Requires an explicitly allocated nonroot Linux host with the reviewed outer
 * seccomp profile. A skipped local case is not Fargate/EC2/TLS acceptance. */
it.runIf(process.env['FSS_SOCIAL_PUBLISHER_HOST_SMOKE']==='1')('six real authenticated Playwright clients retain isolated contexts, reject overflow, render owned data and clean up',async()=>{
 const token=randomBytes(32),clients:Browser[]=[],contexts:BrowserContext[]=[];
 let host:PublisherBrowserHostHandle|undefined;
 try{
  const executablePath=process.env['FSS_SOCIAL_PUBLISHER_CHROMIUM_PATH'];
  host=await startPublisherBrowserHost({token,host:'127.0.0.1',port:0,...(executablePath?{executablePath}:{})});
  const origin=`http://127.0.0.1:${host.address.port}`;
  const endpoint=`ws://127.0.0.1:${host.address.port}/social/publisher-runtime/browser`;
  const connect=()=>chromium.connect(endpoint,{headers:{Authorization:`Bearer ${token.toString('base64')}`},timeout:10000});
  expect((await fetch(`${origin}/health`)).status).toBe(200);
  for(let index=0;index<6;index++){
   const browser=await connect();clients.push(browser);
   const context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block',viewport:{width:320,height:240}});contexts.push(context);
   await context.route('**/*',route=>route.abort('blockedbyclient'));
   const page=await context.newPage();
   await page.setContent('<title>Owned host fixture</title><h1>Neutral fixture</h1><img alt="Owned pixel fixture" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22%3E%3Crect width=%2220%22 height=%2220%22 fill=%22green%22/%3E%3C/svg%3E">');
   expect(await page.locator('h1').innerText()).toBe('Neutral fixture');
   expect(await page.locator('img').evaluate(async image=>{if(!(image instanceof HTMLImageElement))throw new Error('fixture_image_missing');await image.decode();return [image.naturalWidth,image.naturalHeight];})).toEqual([20,20]);
   const screenshot=await page.screenshot({type:'png'});expect(screenshot.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  }
  await attestPublisherSandbox(clients[0]!,'linux-host');
  await contexts[0]!.addCookies([{name:'fixture_owner',value:'owner-alpha',url:'https://fixture.invalid'}]);
  expect((await contexts[0]!.cookies()).length).toBe(1);
  for(const context of contexts.slice(1))expect(await context.cookies()).toEqual([]);
  await expect(connect()).rejects.toThrow();
  await clients[0]!.close();
  expect(await contexts[1]!.pages()[0]!.title()).toBe('Owned host fixture');
  clients.push(await connect());
  expect((await fetch(`${origin}/health`)).status).toBe(200);
  const disconnected=clients.filter(browser=>browser.isConnected()).map(browser=>{const signal=Promise.withResolvers<void>();browser.once('disconnected',()=>signal.resolve());return signal.promise;});
  await host.close();await host.closed;await Promise.all(disconnected);
  expect(clients.every(browser=>!browser.isConnected())).toBe(true);
  await expect(fetch(`${origin}/health`)).rejects.toThrow();
 }finally{
  await Promise.allSettled(clients.map(browser=>browser.close()));
  await host?.close();token.fill(0);
 }
},120000);
