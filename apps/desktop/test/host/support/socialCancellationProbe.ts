import {app,BrowserWindow,session} from 'electron';
import {cancelLinkedInReceipt} from '../../../src/main/social/adapters/linkedinCancel.ts';
import {createElectronSocialRuntime} from '../../../src/main/social/electronRuntime.ts';
import {socialPartition} from '../../../src/main/social/runtime.ts';
import {linkedinCancellationFixture} from './linkedinCancellationFixture.ts';
void(async()=>{
 app.setPath('userData',process.env['FSS_SOCIAL_PROBE_DATA']!);await app.whenReady();app.dock?.hide();
 const scope={workspaceId:'fixture',userId:'fixture',platform:'linkedin' as const,accountId:'fixture'};
 const partition=session.fromPartition(socialPartition(scope));const fault=process.env['FSS_SOCIAL_FAULT'];
 const fixture=fault==='partial'?linkedinCancellationFixture.replace('When you schedule a post, it automatically posts at the date and time you chose','Still loading'):fault==='changed'?linkedinCancellationFixture.replace('<p>Approved</p>','<p>Changed</p>'):linkedinCancellationFixture;
 await partition.protocol.handle('https',()=>new Response(fixture,{headers:{'content-type':'text/html'}}));
 let shown=0;app.on('browser-window-created',(_event,window)=>window.on('show',()=>shown++));
 const result=await createElectronSocialRuntime().withAccount(scope,async({window,isCurrent})=>{
  const real=window as BrowserWindow;
  const cancelled=await cancelLinkedInReceipt({receiptId:'urn:li:share:123',text:'Approved',scheduleLabel:'Posting Tue, Oct 13, 2026 at 12:00 PM'},{contents:real.webContents,current:isCurrent,accountMatches:async()=>true,wait:()=>new Promise(resolve=>setTimeout(resolve,10))});
  const confirms=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'Number(document.body.dataset.confirms)'}]);
  return {cancelled,confirms,visible:real.isVisible(),focused:real.isFocused()};
 });console.log('SOCIAL_CANCEL_PROBE:'+JSON.stringify({result,shown,remaining:BrowserWindow.getAllWindows().length}));await partition.protocol.unhandle('https');app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
