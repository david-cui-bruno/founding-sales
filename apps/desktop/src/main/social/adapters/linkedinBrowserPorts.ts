import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {probeLinkedInIdentity} from '../identityProbe.ts';
import type {stageLinkedInText} from './linkedinStage.ts';
import {linkedInListNavigationScript} from './linkedinListNavigation.ts';
import {linkedInScheduledListScript} from './linkedinScheduledList.ts';
import {linkedInDetailNavigationScript} from './linkedinDetailNavigation.ts';
import {createLinkedInTextAdapter} from './linkedinAdapter.ts';
import type {SocialAdapterContext} from '../deliveryRunner.ts';
type Port=Parameters<typeof stageLinkedInText>[1]&{loadURL(url:string):Promise<void>};
/** Product-owned hidden browser ports. No cookies, API shortcuts or generic DOM
 * actions. This wiring alone does not make the adapter eligible for activation.
 */
export function createLinkedInBrowserPorts(port:Port){
 const current=()=>{try{const u=new URL(port.contents.getURL());return port.current()&&u.origin==='https://www.linkedin.com'&&!u.username&&!u.password&&['/feed/','/sharing/compose'].includes(u.pathname);}catch{return false;}};
 async function execute(code:string){if(!current())throw new Error('session_changed');const result=await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code}],false);if(!current())throw new Error('session_changed');return result;}
 async function compose(){if(!current())throw new Error('session_changed');await port.loadURL('https://www.linkedin.com/sharing/compose');if(!current())throw new Error('session_changed');}
 return {
 ...port,current,
 async account(){const a=await probeLinkedInIdentity(port.contents,current);return a?{platform:a.platform,externalId:a.externalAccountId,displayName:a.displayName}:null;},
 async openComposer(){await compose();},
 async openScheduledList(){
  await compose();const acted=new Set<string>();
  for(let i=0;i<30;i++){
   const result=z.object({ok:z.boolean(),kind:z.enum(['composer','schedule','list','unknown']).optional()}).parse(await execute(linkedInListNavigationScript('read')));
   if(result.ok&&result.kind==='list')return;
   if(result.ok&&(result.kind==='composer'||result.kind==='schedule')&&!acted.has(result.kind)){
    acted.add(result.kind);const action=result.kind==='composer'?'openSchedule':'openList';z.object({ok:z.literal(true)}).parse(await execute(linkedInListNavigationScript(action)));
   }
   await port.wait();
  }
  throw new Error('scheduled_list_unavailable');
 },
 async list(){return execute(`(()=>{const result=${linkedInScheduledListScript()};return {...result,zone:Intl.DateTimeFormat().resolvedOptions().timeZone};})()`);},
 async detail(receiptId:string){
  const token=randomUUID();z.object({ok:z.literal(true)}).parse(await execute(linkedInDetailNavigationScript({action:'open',receiptId,token})));
  for(let i=0;i<30;i++){
   const result=z.object({ok:z.boolean(),view:z.unknown().optional()}).parse(await execute(linkedInDetailNavigationScript({action:'read',receiptId,token})));
   if(result.ok)return result.view;await port.wait();
  }
  throw new Error('saved_detail_unavailable');
 }
 };
}
export function createLinkedInBrowserAdapter(context:SocialAdapterContext,port:Port){return createLinkedInTextAdapter(context,createLinkedInBrowserPorts(port));}
