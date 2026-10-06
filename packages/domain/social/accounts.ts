import {socialConnectionSchema,LINKEDIN_ADAPTER_VERSION,type SocialConnection} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import type {SocialResult} from './posts.ts';
const owner=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
async function lock(ctx:RepositoryContext){await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-accounts:${ctx.scope.workspaceId}:${owner(ctx)}`]);}
/** Enable only the shipped native LinkedIn adapter; other destinations remain unsupported. */
export async function saveSocialConnection(ctx:RepositoryContext,raw:SocialConnection):Promise<SocialResult<{accountId:string;state:'unsupported'|'connected'}>>{
 const user=owner(ctx);if(!user)return {ok:false,reason:'user_required'};
 const parsed=socialConnectionSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};const input=parsed.data;
 if(input.platform==='facebook'&&input.accountKind!=='page')return {ok:false,reason:'facebook_page_required'};
 if(input.platform!=='facebook'&&input.accountKind!=='profile')return {ok:false,reason:'profile_required'};
 await lock(ctx);
 const old=(await ctx.db.query<{owner_user_id:string;platform:string;external_id:string;account_kind:string}>('SELECT owner_user_id,platform,external_id,account_kind FROM social_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,input.accountId])).rows[0];
 if(old&&old.owner_user_id!==user)return {ok:false,reason:'not_found'};
 if(old&&(old.platform!==input.platform||old.external_id!==input.externalId||old.account_kind!==input.accountKind))return {ok:false,reason:'account_identity_changed'};
 if(!old){
  const duplicate=(await ctx.db.query('SELECT 1 FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND platform=$3 AND external_id=$4',[ctx.scope.workspaceId,user,input.platform,input.externalId])).rows.length>0;
  if(duplicate)return {ok:false,reason:'account_already_connected'};
  const count=(await ctx.db.query<{count:number}>('SELECT count(*)::integer AS count FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2',[ctx.scope.workspaceId,user])).rows[0]!.count;
  if(count>=30)return {ok:false,reason:'account_limit'};
  await ctx.db.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state) VALUES($1,$2,$3,$4,$5,$6,$7,'unsupported')",[ctx.scope.workspaceId,input.accountId,user,input.platform,input.externalId,input.displayName,input.accountKind]);
 }else{
  await ctx.db.query("UPDATE social_accounts SET display_name=$3,state='unsupported',revision=revision+1,adapter_version=NULL,verified_at=NULL,max_schedule_days=NULL WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,input.accountId,input.displayName]);
 }
 const state=input.platform==='linkedin'?'connected':'unsupported';
 if(state==='connected')await ctx.db.query("UPDATE social_accounts SET state='connected',adapter_version=$3,verified_at=now(),max_schedule_days=30 WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,input.accountId,LINKEDIN_ADAPTER_VERSION]);
 await recordCrmAuditEvent(ctx,{action:'social.account_observed',subjectKind:'social_account',subjectId:input.accountId,detail:{platform:input.platform,accountKind:input.accountKind}});
 return {ok:true,value:{accountId:input.accountId,state}};
}
export async function disconnectSocialAccount(ctx:RepositoryContext,input:{accountId:string}):Promise<SocialResult<{state:'disconnected'}>>{
 const user=owner(ctx);if(!user)return {ok:false,reason:'user_required'};await lock(ctx);
 const result=await ctx.db.query("UPDATE social_accounts SET state='disconnected',revision=revision+1,adapter_version=NULL,verified_at=NULL,max_schedule_days=NULL WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 RETURNING id",[ctx.scope.workspaceId,input.accountId,user]);
 if(!result.rows.length)return {ok:false,reason:'not_found'};
 // Existing native schedules are not recalled by deleting a local login. Their
 // receipts and pending cancellation state must remain for a later reconnect.
 await recordCrmAuditEvent(ctx,{action:'social.account_disconnected',subjectKind:'social_account',subjectId:input.accountId,detail:{}});
 return {ok:true,value:{state:'disconnected'}};
}
