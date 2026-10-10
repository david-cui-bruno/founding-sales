import {z} from 'zod';
import type {LinkedInIdentityFailure} from '../identity.ts';
import type {AccountIdentity} from '../adapters.ts';
import type {SocialDiagnosticReporter} from '../../../shared/socialDiagnostics.ts';
import {linkedInDomScript} from './linkedinDom.ts';
export type PreparationCheck={ready:true}|{ready:false;reason:string};
interface Ports{current():boolean;preparationCurrent?():boolean;probeAccount?():Promise<{identity:AccountIdentity}|{reason:LinkedInIdentityFailure}>;account():Promise<AccountIdentity|null>;openComposer():Promise<void>;wait():Promise<void>;contents:{executeJavaScriptInIsolatedWorld(world:number,scripts:{code:string}[],gesture?:boolean):Promise<unknown>};diagnostic?:SocialDiagnosticReporter|undefined}
/** Read-only harness: deliberately has no text insertion, claim, marker, schedule or submit ports. */
export async function inspectLinkedInPreparation(expected:AccountIdentity,port:Ports):Promise<PreparationCheck>{
 // Session lifetime is independent of page readiness; the detailed probe still fences allowed pages.
 const current=()=>port.preparationCurrent?.()??port.current();
 let stage:'identity'|'composer'='identity';const refuse=(reason:string):PreparationCheck=>{port.diagnostic?.(stage,'refused',reason);return {ready:false,reason};};
 const identity=async():Promise<string|null>=>{
  // At most twelve reads and eleven product 500ms waits; runtime also bounds the complete operation.
  let unavailable='identity_unavailable';
  for(let i=0;i<12;i++){
   if(!current())return 'session_changed';
   const result=port.probeAccount?await port.probeAccount():{identity:await port.account()};
   if(!current())return 'session_changed';
   if('reason' in result){if(result.reason==='session_changed'||result.reason==='identity_page_unavailable')return result.reason;unavailable=result.reason;}
   const a='identity' in result?result.identity:null;
   if(a)return a.platform===expected.platform&&a.externalId===expected.externalId&&a.displayName===expected.displayName?null:'account_identity_changed';
   if(i<11)await port.wait();
  }
  return unavailable;
 };
 try{
  port.diagnostic?.('identity','started');if(!current())return refuse('session_changed');const identityReason=await identity();if(identityReason)return refuse(identityReason);port.diagnostic?.('identity','succeeded');
  stage='composer';port.diagnostic?.(stage,'started');await port.openComposer();
  for(let i=0;i<12;i++){
   if(!current())return refuse('session_changed');if(!port.current())return refuse('identity_page_unavailable');
   const raw=await port.contents.executeJavaScriptInIsolatedWorld(1001,[{code:linkedInDomScript({action:'read'})}],false);
   if(!current())return refuse('session_changed');if(!port.current())return refuse('identity_page_unavailable');
   const read=z.object({ok:z.literal(true),view:z.object({kind:z.literal('composer'),postingName:z.string(),text:z.string()})}).safeParse(raw);
   if(read.success){if(read.data.view.postingName!==expected.displayName)return refuse('account_identity_changed');const reason=await identity();if(reason)return refuse(reason);if(read.data.view.text.trim())return refuse('existing_draft');port.diagnostic?.(stage,'succeeded');return {ready:true};}
   await port.wait();
  }
  return refuse('layout_changed');
 }catch{return refuse(current()?'preparation_unavailable':'session_changed');}
}
