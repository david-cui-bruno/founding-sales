import {app,BrowserWindow,session} from 'electron';
import {stageLinkedInPost} from '../../../src/main/social/adapters/linkedinPostStage.ts';
import {createElectronSocialRuntime} from '../../../src/main/social/electronRuntime.ts';
import {socialPartition} from '../../../src/main/social/runtime.ts';
import {linkedinComposerFixture} from './linkedinComposerFixture.ts';
void(async()=>{
 app.setPath('userData',process.env['FSS_SOCIAL_PROBE_DATA']!);await app.whenReady();app.dock?.hide();
 const scope={workspaceId:'fixture',userId:'fixture',platform:'linkedin' as const,accountId:'fixture'};
 const partition=session.fromPartition(socialPartition(scope));
 const fault=process.env['FSS_SOCIAL_FAULT'];
 const fixture=fault==='alt'?linkedinComposerFixture.replace('alt=field.value;',"alt='Wrong alt';"):fault==='text'?linkedinComposerFixture.replace('media.remove();input.remove();composer();',"media.remove();input.remove();text='Changed text';composer();"):linkedinComposerFixture;
 await partition.protocol.handle('https',()=>new Response(fixture,{headers:{'content-type':'text/html'}}));
 let shown=0;app.on('browser-window-created',(_event,window)=>window.on('show',()=>shown++));
 const result=await createElectronSocialRuntime().withAccount(scope,async({window,isCurrent})=>{
  const real=window as BrowserWindow;await real.loadURL('https://www.linkedin.com/sharing/compose');
  const stage=await stageLinkedInPost({deliveryId:'fixture',postId:'fixture',revision:1,account:{platform:'linkedin',externalId:'fixture',displayName:'Fixture Founder'},text:'Approved image post',images:[{assetId:'fixture',version:1,localPath:process.env['FSS_SOCIAL_IMAGE']!,sha256:process.env['FSS_SOCIAL_HASH']!,altText:'Synthetic image'}],publishAt:'2026-11-02T15:00:00Z',zone:'America/New_York',fingerprint:'fixture'},{root:process.env['FSS_SOCIAL_ROOT']!,contents:real.webContents,current:isCurrent,now:()=>Date.parse('2026-10-06T12:00:00Z'),wait:()=>new Promise(resolve=>setTimeout(resolve,20))});
  const preview=await real.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'({text:document.querySelector("[contenteditable]").textContent,alt:document.querySelector("img")?.alt,loaded:document.querySelector("img")?.complete,dialogs:document.querySelectorAll("dialog[open]").length})'}]);
  return {stage,preview,visible:real.isVisible(),focused:real.isFocused()};
 });console.log('SOCIAL_IMAGE_PROBE:'+JSON.stringify({result,shown,remaining:BrowserWindow.getAllWindows().length}));await partition.protocol.unhandle('https');app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
