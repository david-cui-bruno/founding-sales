import {app,BrowserWindow,session} from 'electron';
import {createElectronSocialRuntime} from '../../../src/main/social/electronRuntime.ts';
import {socialPartition} from '../../../src/main/social/runtime.ts';
import {inspectLinkedInPreparation} from '../../../src/main/social/adapters/linkedinPreparation.ts';
import {probeLinkedInIdentityDetailed} from '../../../src/main/social/identityProbe.ts';
import {linkedinComposerFixture} from './linkedinComposerFixture.ts';
void(async()=>{
 app.setPath('userData',process.env['FSS_SOCIAL_PROBE_DATA']!);await app.whenReady();app.dock?.hide();
 const scope={workspaceId:'fixture',userId:'fixture',platform:'linkedin' as const,accountId:'fixture'};const partition=session.fromPartition(socialPartition(scope));
 const sidebar='<aside aria-label="Sidebar"><a href="https://www.linkedin.com/in/fixture/"><div aria-label="Fixture Founder, profile"><p>Fixture Founder</p></div></a><a href="https://www.linkedin.com/in/fixture/"><img alt="Fixture Founder"></a></aside>';
 await partition.protocol.handle('https',request=>new Response(request.url.includes('/sharing/compose')?linkedinComposerFixture.replace('</body>',sidebar+'</body>'):`<!doctype html><body><script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(sidebar)}),300)</script></body>`,{headers:{'content-type':'text/html'}}));let shown=0;app.on('browser-window-created',(_event,window)=>window.on('show',()=>shown++));
 const result=await createElectronSocialRuntime().withAccount(scope,async({window,isCurrent})=>{
  const native=window as BrowserWindow;const expected={platform:'linkedin' as const,externalId:'fixture',displayName:'Fixture Founder'};
  let waits=0;
  const ports={current:isCurrent,account:async()=>null,probeAccount:async()=>{const observed=await probeLinkedInIdentityDetailed(native.webContents,isCurrent);return 'reason' in observed?observed:{identity:{platform:observed.platform,externalId:observed.externalAccountId,displayName:observed.displayName}};},contents:native.webContents,openComposer:async()=>{await native.loadURL('https://www.linkedin.com/sharing/compose');await native.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:"window.clicks=0;document.addEventListener('click',()=>window.clicks++,true)"}]);},wait:async()=>{waits++;await new Promise(resolve=>setTimeout(resolve,50));}};
  const check=await inspectLinkedInPreparation({...expected,externalId:'https://www.linkedin.com/in/fixture/'},ports);
  const unchanged=await native.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:"({clicks:window.clicks,text:document.querySelector('[contenteditable]').textContent,schedule:document.querySelector('#summary').textContent})"}]);return {check,waited:waits>0,unchanged,visible:native.isVisible(),focused:native.isFocused()};
 });console.log('SOCIAL_PREPARATION_PROBE:'+JSON.stringify({result,shown,remaining:BrowserWindow.getAllWindows().length}));await partition.protocol.unhandle('https');app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
