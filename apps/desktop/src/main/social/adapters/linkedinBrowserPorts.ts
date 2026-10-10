import {linkedInSaveSettlementScript} from './linkedinSaveSettlement.ts';
import {randomUUID} from 'node:crypto';
import {linkedInPublishedDetailScript} from './linkedinPublishedDetail.ts';
import {z} from 'zod';
import {probeLinkedInIdentity,probeLinkedInIdentityDetailed} from '../identityProbe.ts';
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
 preparationCurrent:port.current,
 async probeAccount(){const a=await probeLinkedInIdentityDetailed(port.contents,port.current);return 'reason' in a?a:{identity:{platform:a.platform,externalId:a.externalAccountId,displayName:a.displayName}};},
 async account(){const a=await probeLinkedInIdentity(port.contents,current);return a?{platform:a.platform,externalId:a.externalAccountId,displayName:a.displayName}:null;},
 async openComposer(){await compose();},
 async waitForSave(){
  // Completion only permits receipt inspection. It never proves scheduling.
  try{for(let i=0;i<30;i++){
   if(!current())return false;
   const result=z.strictObject({settled:z.boolean()}).parse(await execute(linkedInSaveSettlementScript()));
   if(result.settled)return true;
   await port.wait();
  }}catch{return false;}
  return false;
 },
 async openScheduledList(){
  await compose();const acted=new Set<string>();
  for(let i=0;i<30;i++){
   const result=z.object({ok:z.boolean(),kind:z.enum(['composer','schedule','list','unknown']).optional()}).parse(await execute(linkedInListNavigationScript('read')));
   if(result.ok&&result.kind==='list')return;
   if(result.ok&&(result.kind==='composer'||result.kind==='schedule')&&!acted.has(result.kind)){
    const action=result.kind==='composer'?'openSchedule':'openList';const navigation=z.strictObject({ok:z.boolean()}).parse(await execute(linkedInListNavigationScript(action)));if(navigation.ok)acted.add(result.kind);
   }
   await port.wait();
  }
  throw new Error('scheduled_list_unavailable');
 },
 async published(receiptId:string,imageCount=0){
  if(!/^urn:li:share:\d+$/.test(receiptId)||!current())throw new Error('invalid_publication_lookup');
  const target=`https://www.linkedin.com/feed/update/${receiptId}/`;
  const atTarget=()=>port.current()&&port.contents.getURL()===target;
  try{
   await port.loadURL(target);if(!atTarget())throw new Error('publication_navigation_changed');
   for(let i=0;i<30;i++){
    if(!atTarget())throw new Error('session_changed');
    const result=z.object({ok:z.boolean(),view:z.unknown().optional()}).parse(await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInPublishedDetailScript(imageCount)}],false));
    if(!atTarget())throw new Error('session_changed');
    if(result.ok)return result;await port.wait();
   }
   return {ok:false};
  }finally{
   // Restore the independently observed own-profile surface before account recheck.
   // Do not navigate a session that was signed out, redirected or invalidated.
   if(atTarget())await port.loadURL('https://www.linkedin.com/feed/');
  }
 },
 async list(){for(let i=0;i<30;i++){const result=await execute(`(()=>{const result=${linkedInScheduledListScript()};return {...result,zone:Intl.DateTimeFormat().resolvedOptions().timeZone};})()`);if(z.object({ok:z.literal(true),complete:z.literal(true)}).safeParse(result).success)return result;await port.wait();}return {ok:false};},
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
