import {socialConnectionSchema,type SocialConnection} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import type {SocialResult} from './posts.ts';

/** Explicit human-supplied identity only. Never registers a native/cloud adapter. */
export async function registerSocialManualDestination(ctx:RepositoryContext,raw:SocialConnection):Promise<SocialResult<{accountId:string;state:'unsupported'}>>{
 if(ctx.scope.actor.kind!=='user')return {ok:false,reason:'user_required'};const user=ctx.scope.actor.userId;
 const parsed=socialConnectionSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};const input=parsed.data;
 if(input.platform==='facebook'&&input.accountKind!=='page')return {ok:false,reason:'facebook_page_required'};
 if(input.platform!=='facebook'&&input.accountKind!=='profile')return {ok:false,reason:'profile_required'};
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-accounts:${ctx.scope.workspaceId}:${user}`]);
 const old=(await ctx.db.query<{owner_user_id:string;platform:string;external_id:string;display_name:string;account_kind:string;state:string;adapter_version:string|null;verified_at:Date|string|null}>('SELECT owner_user_id,platform,external_id,display_name,account_kind,state,adapter_version,verified_at FROM social_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,input.accountId])).rows[0];
 if(old&&old.owner_user_id!==user)return {ok:false,reason:'not_found'};
 if(old&&(old.state==='connected'||old.state==='reconnect'||old.adapter_version!==null||old.verified_at!==null))return {ok:false,reason:'destination_already_connected'};
 if(old&&(old.platform!==input.platform||old.external_id!==input.externalId||old.account_kind!==input.accountKind))return {ok:false,reason:'account_identity_changed'};
 if(old&&old.state==='unsupported'&&old.display_name===input.displayName)return {ok:true,value:{accountId:input.accountId,state:'unsupported'}};
 if(old){await ctx.db.query("UPDATE social_accounts SET display_name=$3,state='unsupported',revision=revision+1,adapter_version=NULL,verified_at=NULL,max_schedule_days=NULL WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,input.accountId,input.displayName]);}
 else{
  if((await ctx.db.query('SELECT 1 FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND platform=$3 AND external_id=$4',[ctx.scope.workspaceId,user,input.platform,input.externalId])).rows.length)return {ok:false,reason:'account_already_registered'};
  const count=(await ctx.db.query<{count:number}>('SELECT count(*)::integer AS count FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2',[ctx.scope.workspaceId,user])).rows[0]!.count;
  if(count>=30)return {ok:false,reason:'account_limit'};
  await ctx.db.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state) VALUES($1,$2,$3,$4,$5,$6,$7,'unsupported')",[ctx.scope.workspaceId,input.accountId,user,input.platform,input.externalId,input.displayName,input.accountKind]);
 }
 await recordCrmAuditEvent(ctx,{action:'social.manual_destination_recorded',subjectKind:'social_account',subjectId:input.accountId,detail:{platform:input.platform,accountKind:input.accountKind}});
 return {ok:true,value:{accountId:input.accountId,state:'unsupported'}};
}
