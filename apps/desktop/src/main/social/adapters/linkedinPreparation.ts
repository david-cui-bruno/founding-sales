import {z} from 'zod';
import type {AccountIdentity} from '../adapters.ts';
import type {SocialDiagnosticReporter} from '../../../shared/socialDiagnostics.ts';
import {linkedInDomScript} from './linkedinDom.ts';
export type PreparationCheck={ready:true}|{ready:false;reason:string};
interface Ports{current():boolean;account():Promise<AccountIdentity|null>;openComposer():Promise<void>;wait():Promise<void>;contents:{executeJavaScriptInIsolatedWorld(world:number,scripts:{code:string}[],gesture?:boolean):Promise<unknown>};diagnostic?:SocialDiagnosticReporter|undefined}
/** Read-only harness: deliberately has no text insertion, claim, marker, schedule or submit ports. */
export async function inspectLinkedInPreparation(expected:AccountIdentity,port:Ports):Promise<PreparationCheck>{
 let stage:'identity'|'composer'='identity';const refuse=(reason:string):PreparationCheck=>{port.diagnostic?.(stage,'refused',reason);return {ready:false,reason};};
 const same=async()=>{const a=await port.account();return port.current()&&a?.platform===expected.platform&&a.externalId===expected.externalId&&a.displayName===expected.displayName;};
 try{
  port.diagnostic?.('identity','started');if(!port.current())return refuse('session_changed');if(!await same())return refuse('account_identity_changed');port.diagnostic?.('identity','succeeded');
  stage='composer';port.diagnostic?.(stage,'started');await port.openComposer();
  for(let i=0;i<12;i++){
   if(!port.current())return refuse('session_changed');
   const raw=await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInDomScript({action:'read'})}],false);
   if(!port.current())return refuse('session_changed');
   const read=z.object({ok:z.literal(true),view:z.object({kind:z.literal('composer'),postingName:z.string(),text:z.string()})}).safeParse(raw);
   if(read.success){if(read.data.view.postingName!==expected.displayName||!await same())return refuse('account_identity_changed');if(read.data.view.text.trim())return refuse('existing_draft');port.diagnostic?.(stage,'succeeded');return {ready:true};}
   await port.wait();
  }
  return refuse('layout_changed');
 }catch{return refuse(port.current()?'preparation_unavailable':'session_changed');}
}
