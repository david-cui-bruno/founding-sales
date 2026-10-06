import {probeLinkedInIdentity} from '../../../src/main/social/identityProbe.ts';
import {app,BrowserWindow,session} from 'electron';
import {createElectronSocialRuntime} from '../../../src/main/social/electronRuntime.ts';
import {socialPartition} from '../../../src/main/social/runtime.ts';
void (async()=>{
app.setPath('userData',process.env['FSS_SOCIAL_PROBE_DATA']!);
await app.whenReady();app.dock?.hide();
const scope={workspaceId:'fixture',userId:'fixture',platform:'linkedin' as const,accountId:'fixture'};
const partition=session.fromPartition(socialPartition(scope));
await partition.protocol.handle('https',()=>new Response('<!doctype html><html><body><aside aria-label="Sidebar"><a href="https://www.linkedin.com/in/fixture/"><img alt="Fixture Founder"></a><a href="https://www.linkedin.com/in/fixture/"><div aria-label="Fixture Founder, Founder"><p>Fixture Founder</p></div></a></aside><main data-account="fixture"><textarea aria-label="Post text"></textarea><button id="schedule">Schedule</button></main></body></html>',{headers:{'content-type':'text/html'}}));
let shown=0;app.on('browser-window-created',(_event,window)=>window.on('show',()=>shown++));
const runtime=createElectronSocialRuntime();
const result=await runtime.withAccount(scope,async({window,isCurrent})=>{
 const real=window as BrowserWindow;
 const isolation=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'({node:typeof require,process:typeof process,bridge:typeof window.callie,account:document.querySelector("main").dataset.account})'}]);
 const identity=await probeLinkedInIdentity(real.webContents,isCurrent);
 return {identity,isolation,visible:real.isVisible(),focused:real.isFocused(),current:isCurrent(),windows:BrowserWindow.getAllWindows().length};
});
console.log('SOCIAL_PROBE:'+JSON.stringify({result,shown,remaining:BrowserWindow.getAllWindows().length}));
await partition.protocol.unhandle('https');app.quit();

})().catch(error=>{console.error(error);app.exit(1);});
