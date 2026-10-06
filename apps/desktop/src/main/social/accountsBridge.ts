import {z} from 'zod';
import {socialWorkspaceSchema,type SocialConnection} from '@fss/contracts';
import type {AuthedClient} from '../authedClient.ts';
import type {ObservedSocialIdentity} from './identity.ts';
import type {SocialScope} from './runtime.ts';
interface Input {accountId:string;commandId:string}
interface Deps {api:AuthedClient;identity():Promise<{workspaceId:string;userId:string}|null>;generation():number;open(scope:SocialScope):Promise<ObservedSocialIdentity|null>;clear(scope:SocialScope):Promise<void>}
const result=(reason:string|null)=>({accepted:reason===null,reason});
/** Renderer supplies opaque command/account IDs, never a claimed browser identity. */
export function createSocialAccountsBridge(deps:Deps){
 let busy=false,epoch=deps.generation();
 const pending=new Map<string,{accountId:string;payload:SocialConnection}>();
 async function run(input:Input,disconnect:boolean){
  if(busy)return result('account_busy');busy=true;
  const generation=deps.generation(),current=()=>generation===deps.generation();
  try{
   if(epoch!==generation){pending.clear();epoch=generation;}
   const identity=await deps.identity();if(!identity||!current())return result('session_changed');
   const workspace=await deps.api.read('/social',v=>socialWorkspaceSchema.parse(v),{});
   if(!current())return result('session_changed');if(!workspace.ok)return result(workspace.reason);
   const account=workspace.value.accounts.find(a=>a.id===input.accountId);
   if(disconnect){
    if(!account)return result('not_found');
    const answer=await deps.api.command('/social/accounts/disconnect',{accountId:input.accountId},v=>z.strictObject({state:z.literal('disconnected')}).parse(v),{commandId:input.commandId});
    if(!current())return result('session_changed');if(!answer.ok)return result(answer.reason);
    try{await deps.clear({...identity,accountId:input.accountId,platform:account.platform});}catch{return result('login_cleanup_failed');}
    for(const [key,value] of pending)if(value.accountId===input.accountId)pending.delete(key);
    return result(current()?null:'session_changed');
   }
   if(account&&account.platform!=='linkedin')return result('platform_not_ready');
   let saved=pending.get(input.commandId);
   if(saved&&saved.accountId!==input.accountId)return result('command_mismatch');
   if(!saved){
    if(pending.size>=30)return result('pending_connection_limit');
    const observed=await deps.open({...identity,accountId:input.accountId,platform:'linkedin'});
    if(!current())return result('session_changed');if(!observed)return result('identity_not_verified');
    if(account&&account.externalId!==observed.externalAccountId)return result('account_identity_changed');
    saved={accountId:input.accountId,payload:{accountId:input.accountId,platform:observed.platform,externalId:observed.externalAccountId,displayName:observed.displayName,accountKind:observed.accountKind}};
    pending.set(input.commandId,saved);
   }
   const answer=await deps.api.command('/social/accounts/connect',saved.payload,v=>z.strictObject({accountId:z.string().uuid(),state:z.literal('unsupported')}).parse(v),{commandId:input.commandId});
   if(!current())return result('session_changed');if(answer.ok)pending.delete(input.commandId);return result(answer.ok?null:answer.reason);
  }catch{return result(current()?'connection_unavailable':'session_changed');}finally{busy=false;}
 }
 return {connect:(input:Input)=>run(input,false),disconnect:(input:Input)=>run(input,true)};
}
export type SocialAccountsBridge=ReturnType<typeof createSocialAccountsBridge>;
