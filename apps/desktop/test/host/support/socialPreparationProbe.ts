import {app,BrowserWindow,session} from 'electron';
import {createElectronSocialRuntime} from '../../../src/main/social/electronRuntime.ts';
import {socialPartition} from '../../../src/main/social/runtime.ts';
import {inspectLinkedInPreparation} from '../../../src/main/social/adapters/linkedinPreparation.ts';
import {linkedinComposerFixture} from './linkedinComposerFixture.ts';
void(async()=>{
 app.setPath('userData',process.env['FSS_SOCIAL_PROBE_DATA']!);await app.whenReady();app.dock?.hide();
 const scope={workspaceId:'fixture',userId:'fixture',platform:'linkedin' as const,accountId:'fixture'};const partition=session.fromPartition(socialPartition(scope));
 await partition.protocol.handle('https',()=>new Response(linkedinComposerFixture,{headers:{'content-type':'text/html'}}));let shown=0;app.on('browser-window-created',(_event,window)=>window.on('show',()=>shown++));
 const result=await createElectronSocialRuntime().withAccount(scope,async({window,isCurrent})=>{
  const native=window as BrowserWindow;const expected={platform:'linkedin' as const,externalId:'fixture',displayName:'Fixture Founder'};
  const check=await inspectLinkedInPreparation(expected,{current:isCurrent,account:async()=>expected,openComposer:async()=>{await native.loadURL('https://www.linkedin.com/sharing/compose');await native.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:"window.clicks=0;document.addEventListener('click',()=>window.clicks++,true)"}]);},wait:()=>new Promise(resolve=>setTimeout(resolve,20)),contents:native.webContents});
  const unchanged=await native.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:"({clicks:window.clicks,text:document.querySelector('[contenteditable]').textContent,schedule:document.querySelector('#summary').textContent})"}]);return {check,unchanged,visible:native.isVisible(),focused:native.isFocused()};
 });console.log('SOCIAL_PREPARATION_PROBE:'+JSON.stringify({result,shown,remaining:BrowserWindow.getAllWindows().length}));await partition.protocol.unhandle('https');app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
