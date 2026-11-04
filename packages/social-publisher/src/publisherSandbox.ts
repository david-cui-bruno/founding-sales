import type {Browser} from 'playwright';
import {PublisherRefusal} from './publisherLinkedin.ts';

/** Chromium's own Linux renderer status, not launch options or inherited outer seccomp.
 * Native booleans are supplied by SandboxInternalsUI::SetSandboxStatusData.
 * https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/webui/sandbox/sandbox_internals_ui.cc
 * No platform traffic, account state, screenshots or persisted diagnostics. */
export async function attestPublisherSandbox(browser:Browser,mode:'local'|'linux-host'):Promise<void>{
 if(mode==='local'&&process.platform!=='linux')return;
 const context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block'});
 try{
  const page=await context.newPage();
  await page.goto('chrome://sandbox/',{waitUntil:'load',timeout:10000});
  // Keep this WebUI program literal: Vite rewrites imports in serialized
  // functions into Node-only helpers that do not exist inside Chromium.
  // The Linux chrome:// module exists only in WebUI, not Node's import graph.
  const status=await page.evaluate<{good:unknown;suid:unknown;userNs:unknown;pidNs:unknown;netNs:unknown;seccomp:unknown}>(`(async()=>{
   const {loadTimeData}=await import('chrome://resources/js/load_time_data.js');
   return {good:loadTimeData.getBoolean('sandboxGood'),suid:loadTimeData.getBoolean('suid'),userNs:loadTimeData.getBoolean('userNs'),pidNs:loadTimeData.getBoolean('pidNs'),netNs:loadTimeData.getBoolean('netNs'),seccomp:loadTimeData.getBoolean('seccompBpf')};
  })()`);
  if(status.good!==true||!(status.suid===true||status.userNs===true)||status.pidNs!==true||status.netNs!==true||status.seccomp!==true)throw new PublisherRefusal('renderer_sandbox_unavailable');
 }catch{throw new PublisherRefusal('renderer_sandbox_unavailable');}
 finally{await context.close();}
}
