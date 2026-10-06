import {app,BrowserWindow,session} from 'electron';
import {createElectronSocialRuntime} from '../../../src/main/social/electronRuntime.ts';
import {socialPartition} from '../../../src/main/social/runtime.ts';
import {createLinkedInBrowserAdapter} from '../../../src/main/social/adapters/linkedinBrowserPorts.ts';
import {submitApprovedSocialPost,reconcileSocialPost} from '../../../src/main/social/deliveryLoop.ts';
import {linkedinFlowFixture} from './linkedinFlowFixture.ts';
void(async()=>{
 app.setPath('userData',process.env['FSS_SOCIAL_PROBE_DATA']!);await app.whenReady();app.dock?.hide();app.on('window-all-closed',()=>{});
 const scope={workspaceId:'fixture',userId:'fixture',platform:'linkedin' as const,accountId:'fixture'};
 const partition=session.fromPartition(socialPartition(scope));const fault=process.env['FSS_SOCIAL_FAULT'];
 let publicationPhase=false;
 await partition.protocol.handle('https',request=>{
  let html=linkedinFlowFixture(fault==='changed',fault==='delayed-save');
  if(publicationPhase){
   html=html.replace('<script>',"<script>localStorage.removeItem('receipt');");
   if(new URL(request.url).pathname==='/feed/update/urn:li:share:123/')html='<main aria-label="Feed detail update"><a aria-label="Go to boost post page" href="https://www.linkedin.com/ad-beta/boost/campaigns/new/details?content=urn%3Ali%3Ashare%3A123">Boost</a><div role="article" data-urn="urn:li:activity:456"><a class="update-components-actor__meta-link" href="https://www.linkedin.com/in/fixture/">Fixture Founder</a><div class="update-components-update-v2__commentary">Approved text</div></div></main>';
  }
  return new Response(html,{headers:{'content-type':'text/html'}});
 });
 let lostResponses=0;let menuRefusals=0;let shown=0;app.on('browser-window-created',(_event,window)=>window.on('show',()=>shown++));
 const runtime=createElectronSocialRuntime(),fingerprint='a'.repeat(64),now=()=>Date.parse(publicationPhase?'2026-11-03T12:00:00Z':'2026-10-06T12:00:00Z');
 let context:Parameters<typeof createLinkedInBrowserAdapter>[0];let observed:unknown=null;
 const first=await runtime.withAccount(scope,async({window,isCurrent})=>{
  const real=window as BrowserWindow;
  const zone=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'Intl.DateTimeFormat().resolvedOptions().timeZone'}]);
  context={snapshot:{account:{id:'fixture',platform:'linkedin',externalId:'https://www.linkedin.com/in/fixture/',revision:1,adapterVersion:'fixture'},text:'Approved text',images:[],publishAt:'2026-11-02T15:00:00.000Z',zone},fingerprint,displayName:'Fixture Founder'};
  const execute=real.webContents.executeJavaScriptInIsolatedWorld.bind(real.webContents);
  const contents={getURL:()=>real.webContents.getURL(),insertText:(text:string)=>real.webContents.insertText(text),executeJavaScriptInIsolatedWorld:async(world:number,scripts:{code:string}[],gesture?:boolean)=>{if(fault==='time-menu'&&menuRefusals===0&&scripts[0]!.code.includes('const input={"action":"selectTime"')){menuRefusals++;return {ok:false,reason:'time_menu_unavailable'};}const result=await execute(world,scripts,gesture);if(fault==='lost'&&scripts[0]!.code.includes("const key='__callieLinkedInSubmission'")){lostResponses++;throw new Error('lost response');}return result;}};
  const adapter=createLinkedInBrowserAdapter(context,{contents,loadURL:url=>real.loadURL(url),current:isCurrent,now,wait:()=>new Promise(resolve=>setTimeout(resolve,10))});
  const result=await submitApprovedSocialPost({deliveryId:'d',postId:'p',revision:1,account:{platform:'linkedin',externalId:context.snapshot.account.externalId,displayName:'Fixture Founder'},text:'Approved text',images:[],publishAt:context.snapshot.publishAt,zone,fingerprint},adapter,{current:isCurrent,now,claim:async()=>({ok:true,claimId:'claim',approvalId:'approval',fingerprint,expiresAt:'2026-10-06T12:05:00Z'}),begin:async()=>({ok:true,submissionId:'submission'}),observe:async(_id,value)=>{observed=value;return true;}});
  return {result,visible:real.isVisible(),focused:real.isFocused()};
 });
 publicationPhase=fault==='published';
 const second=await runtime.withAccount(scope,async({window,isCurrent})=>{
  const real=window as BrowserWindow;const adapter=createLinkedInBrowserAdapter(context!,{contents:real.webContents,loadURL:url=>real.loadURL(url),current:isCurrent,now,wait:()=>new Promise(resolve=>setTimeout(resolve,10))});
  const result=await reconcileSocialPost({account:{platform:'linkedin',externalId:context!.snapshot.account.externalId,displayName:'Fixture Founder'},fingerprint},{submissionId:'submission',receiptId:publicationPhase?'urn:li:share:123':null,cancel:!publicationPhase},adapter,{current:isCurrent,now,observe:async()=>true});
  const counts=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:"({submits:Number(localStorage.getItem('submits')||0),deletes:Number(localStorage.getItem('deletes')||0)})"}]);return {result,counts,visible:real.isVisible(),focused:real.isFocused()};
 });
 console.log('SOCIAL_FLOW_PROBE:'+JSON.stringify({first,second,observed,lostResponses,menuRefusals,shown,remaining:BrowserWindow.getAllWindows().length}));await partition.protocol.unhandle('https');app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
