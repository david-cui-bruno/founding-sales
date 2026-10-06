import {app,BrowserWindow,session} from 'electron';
import {stageLinkedInText} from '../../../src/main/social/adapters/linkedinStage.ts';
import {linkedInSubmitScript} from '../../../src/main/social/adapters/linkedinSubmit.ts';
import {createElectronSocialRuntime} from '../../../src/main/social/electronRuntime.ts';
import {socialPartition} from '../../../src/main/social/runtime.ts';
import {linkedinComposerFixture} from './linkedinComposerFixture.ts';
void(async()=>{
 app.setPath('userData',process.env['FSS_SOCIAL_PROBE_DATA']!);await app.whenReady();app.dock?.hide();
 const scope={workspaceId:'fixture',userId:'fixture',platform:'linkedin' as const,accountId:'fixture'};
 const partition=session.fromPartition(socialPartition(scope));
 await partition.protocol.handle('https',()=>new Response(linkedinComposerFixture,{headers:{'content-type':'text/html'}}));
 let shown=0;app.on('browser-window-created',(_event,window)=>window.on('show',()=>shown++));
 const result=await createElectronSocialRuntime().withAccount(scope,async({window,isCurrent})=>{
  const real=window as BrowserWindow;await real.loadURL('https://www.linkedin.com/sharing/compose');
  const stage=await stageLinkedInText({deliveryId:'fixture',postId:'fixture',revision:1,account:{platform:'linkedin',externalId:'fixture',displayName:'Fixture Founder'},text:'Approved text',images:[],publishAt:'2026-11-02T15:00:00Z',zone:'America/New_York',fingerprint:'fixture'},{contents:real.webContents,current:isCurrent,now:()=>Date.parse('2026-10-06T12:00:00Z'),wait:()=>new Promise(resolve=>setTimeout(resolve,20))});
  const expected=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:`(()=>{const button=Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Schedule');button.disabled=false;window.clicks=0;button.onclick=()=>window.clicks++;return {postingName:'Fixture Founder',text:'Approved text',zone:Intl.DateTimeFormat().resolvedOptions().timeZone,scheduleLabel:document.querySelector('#summary').textContent};})()`}]);
  const first=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInSubmitScript({...expected,token:'b6bacf0c-28b2-4290-8eaa-c8647020c3c8'})}]);
  const second=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInSubmitScript({...expected,token:'9b40c38a-ed43-43d0-b227-177c08724fc6'})}]);
  const clicks=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'window.clicks'}]);
  return {stage,first,second,clicks,visible:real.isVisible(),focused:real.isFocused()};
 });console.log('SOCIAL_SUBMIT_PROBE:'+JSON.stringify({result,shown,remaining:BrowserWindow.getAllWindows().length}));await partition.protocol.unhandle('https');app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
