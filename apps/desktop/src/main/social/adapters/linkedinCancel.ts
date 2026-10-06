import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {linkedInCancelScript} from './linkedinCancelDom.ts';
import {linkedInScheduledListScript} from './linkedinScheduledList.ts';
const listSchema=z.strictObject({ok:z.literal(true),total:z.number().int().nonnegative(),complete:z.boolean(),rows:z.array(z.strictObject({receiptId:z.string(),text:z.string(),scheduleLabel:z.string(),images:z.array(z.strictObject({src:z.string(),alt:z.string()}))})).max(100)});
interface Port{current():boolean;accountMatches():Promise<boolean>;wait():Promise<void>;contents:{getURL():string;executeJavaScriptInIsolatedWorld(world:number,scripts:{code:string}[],gesture?:boolean):Promise<unknown>}}
/** Caller must independently match the full approved content/account before invoking.
 * This verifies the exact native row and deletion, not its media fingerprint.
 */
export async function cancelLinkedInReceipt(input:{receiptId:string;text:string;scheduleLabel:string},port:Port):Promise<{state:'cancelled'|'absent'|'unknown'}>{
 const target={...input,token:randomUUID()};
 const current=()=>{try{const u=new URL(port.contents.getURL());return port.current()&&u.origin==='https://www.linkedin.com'&&['/feed/','/sharing/compose'].includes(u.pathname)&&!u.username&&!u.password;}catch{return false;}};
 async function execute(code:string){if(!current())throw new Error('session_changed');const result=await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code}],false);if(!current())throw new Error('session_changed');return result;}
 async function account(){if(!current()||!await port.accountMatches()||!current())throw new Error('account_changed');}
 async function read(){for(let i=0;i<30;i++){const result=await execute(linkedInScheduledListScript());if(!z.strictObject({ok:z.literal(false)}).safeParse(result).success)return listSchema.parse(result);await port.wait();await account();}throw new Error('list_unavailable');}
 try{
  await account();let before=await read();for(let i=0;i<30&&!before.complete&&!before.rows.some(row=>row.receiptId===target.receiptId);i++){await port.wait();await account();before=await read();}const matching=before.rows.filter(row=>row.receiptId===target.receiptId);
  if(matching.length===0)return {state:before.complete?'absent':'unknown'};
  if(matching.length!==1||matching[0]!.text!==target.text||matching[0]!.scheduleLabel!==target.scheduleLabel)return {state:'unknown'};
  for(const action of ['openMenu','deleteMenu','confirm'] as const){
   await account();z.strictObject({ok:z.literal(true)}).parse(await execute(linkedInCancelScript({...target,action})));await port.wait();
  }
  // Read-only polling after the single confirm. Never repeat a deletion on ambiguity.
  for(let i=0;i<30;i++){
   await account();const after=await read();
   if(after.complete&&!after.rows.some(row=>row.receiptId===target.receiptId))return {state:'cancelled'};
   await port.wait();
  }
 }catch{/* A lost result may still have removed the post; reconcile, never repeat blindly. */}
 return {state:'unknown'};
}
