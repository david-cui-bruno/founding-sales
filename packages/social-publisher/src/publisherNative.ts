import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {LaunchOptions} from 'playwright';
import {assertPublisherDebugDisabled} from './publisherConfig.ts';

export interface PrivatePublisherLaunch {
 options:LaunchOptions;
 close():Promise<void>;
}
/** Shared by the isolated host and explicitly local native fixtures only.
 * No inherited controller/AWS/application secrets reach the Chromium subprocess. */
export async function createPrivatePublisherLaunch(executablePath?:string):Promise<PrivatePublisherLaunch>{
 assertPublisherDebugDisabled(process.env);
 const home=await mkdtemp(join(tmpdir(),'fss-social-browser-'));
 return {
  options:{headless:true,chromiumSandbox:true,timeout:20000,env:{PATH:process.env['PATH']??'/usr/local/bin:/usr/bin:/bin',HOME:home,TMPDIR:home,LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'},...(executablePath?{executablePath}:{})},
  async close(){await rm(home,{recursive:true,force:true});},
 };
}
