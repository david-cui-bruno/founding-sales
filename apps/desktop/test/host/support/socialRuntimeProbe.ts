import {linkedInImageInputScript} from '../../../src/main/social/adapters/linkedinImageDom.ts';
import {linkedinComposerFixture} from './linkedinComposerFixture.ts';
import {stageLinkedInText} from '../../../src/main/social/adapters/linkedinStage.ts';
import {probeLinkedInIdentity} from '../../../src/main/social/identityProbe.ts';
import {app,BrowserWindow,session} from 'electron';
import {createElectronSocialRuntime} from '../../../src/main/social/electronRuntime.ts';
import {socialPartition} from '../../../src/main/social/runtime.ts';
void (async()=>{
app.setPath('userData',process.env['FSS_SOCIAL_PROBE_DATA']!);
await app.whenReady();app.dock?.hide();
const scope={workspaceId:'fixture',userId:'fixture',platform:'linkedin' as const,accountId:'fixture'};
const partition=session.fromPartition(socialPartition(scope));
await partition.protocol.handle('https',request=>new Response(request.url.includes('?media')?'<html><body><dialog open data-testid="dialog"><div contenteditable="true">Underlying composer</div></dialog><dialog open data-testid="dialog"><h2>Editor</h2></dialog><input type="file" accept="image/png,image/jpeg" multiple style="display:none"><script>document.querySelector("input").onchange=()=>document.body.dataset.changed="yes";</script></body></html>':request.url.includes('/sharing/compose')?linkedinComposerFixture:'<!doctype html><html><body><aside aria-label="Sidebar"><a href="https://www.linkedin.com/in/fixture/"><img alt="Fixture Founder"></a><a href="https://www.linkedin.com/in/fixture/"><div aria-label="Fixture Founder, Founder"><p>Fixture Founder</p></div></a></aside><main data-account="fixture"><textarea aria-label="Post text"></textarea><button id="schedule">Schedule</button></main></body></html>',{headers:{'content-type':'text/html'}}));
let shown=0;app.on('browser-window-created',(_event,window)=>window.on('show',()=>shown++));
const runtime=createElectronSocialRuntime();
const result=await runtime.withAccount(scope,async({window,isCurrent})=>{
 const real=window as BrowserWindow;
 const isolation=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'({node:typeof require,process:typeof process,bridge:typeof window.callie,account:document.querySelector("main").dataset.account})'}]);
 const identity=await probeLinkedInIdentity(real.webContents,isCurrent);
 await real.loadURL('https://www.linkedin.com/sharing/compose');
 const stage=await stageLinkedInText({deliveryId:'fixture',postId:'fixture',revision:1,account:{platform:'linkedin',externalId:'https://www.linkedin.com/in/fixture/',displayName:'Fixture Founder'},text:'Fixture approved text',images:[],publishAt:'2026-11-02T15:00:00Z',zone:'America/New_York',fingerprint:'fixture'},{contents:real.webContents,current:isCurrent,now:()=>Date.parse('2026-10-06T12:00:00Z'),wait:()=>new Promise(resolve=>setTimeout(resolve,100))});
 await real.loadURL('https://www.linkedin.com/sharing/compose?media');
 const media=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInImageInputScript([{name:'image-1.png',mime:'image/png',base64:Buffer.from('fixture').toString('base64')}])}],false);
 const mediaRead=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'(async()=>{const f=document.querySelector("input").files[0];return {name:f.name,type:f.type,text:await f.text(),changed:document.body.dataset.changed==="yes"};})()'}],false);
 return {media,mediaRead,stage,identity,isolation,visible:real.isVisible(),focused:real.isFocused(),current:isCurrent(),windows:BrowserWindow.getAllWindows().length};
});
console.log('SOCIAL_PROBE:'+JSON.stringify({result,shown,remaining:BrowserWindow.getAllWindows().length}));
await partition.protocol.unhandle('https');app.quit();

})().catch(error=>{console.error(error);app.exit(1);});
