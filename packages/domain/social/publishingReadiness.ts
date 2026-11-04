import {socialPublishingReadinessSchema,type SocialPublishingReadiness,type SocialPublishingReadinessHold,type SocialPublisherPort,type SocialPublisherBinding} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {requirePrivateDraftAuthority,type PrivateDraftAuthority} from './privateDrafts.ts';
import type {SocialResult} from './posts.ts';
import {currentStandingConfiguration} from './standingAuthority.ts';

interface Account extends Record<string,unknown>{
 id:string;revision:number;platform:'linkedin'|'facebook'|'x';account_kind:'profile'|'page';
 display_name:string;state:'connected'|'reconnect'|'unsupported'|'disconnected';external_id:string;
 session_id:string|null;session_revision:number|null;session_account_revision:number|null;
}
/** Current capability and self-account readback, not a config flag or legacy marker.
 * Caller retains membership/principal locks through final projection. */
export async function readSocialPublishingReadiness(
 ctx:RepositoryContext,authority:PrivateDraftAuthority,publisher?:Pick<SocialPublisherPort,'verify'>,
):Promise<SocialResult<SocialPublishingReadiness>>{
 const actor=ctx.scope.actor;
 if(actor.kind!=='user'||actor.role!=='admin')return {ok:false,reason:'admin_required'};
 const active=(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role='admin' AND status='active' FOR UPDATE",[ctx.scope.workspaceId,actor.userId])).rows.length===1;
 if(!active)return {ok:false,reason:'owner_unavailable'};
 await requirePrivateDraftAuthority(authority);
 const plan=(await ctx.db.query<{id:string;revision:number}>("SELECT id,revision FROM social_standing_plans WHERE workspace_id=$1 AND owner_user_id=$2 AND state='active' ORDER BY id LIMIT 1",[ctx.scope.workspaceId,actor.userId])).rows[0];
 const configuration=plan?await currentStandingConfiguration(ctx,actor.userId,{planId:plan.id,revision:plan.revision}):null;
 const rows=(await ctx.db.query<Account>(`SELECT a.id,a.revision,a.platform,a.account_kind,a.display_name,a.state,a.external_id,
  s.id AS session_id,s.revision AS session_revision,s.account_revision AS session_account_revision
  FROM social_accounts a LEFT JOIN social_publisher_sessions s ON s.workspace_id=a.workspace_id AND s.account_id=a.id AND s.owner_user_id=a.owner_user_id AND s.state='usable' AND s.expires_at>clock_timestamp()
  WHERE a.workspace_id=$1 AND a.owner_user_id=$2 ORDER BY a.id LIMIT 31 FOR SHARE OF a`,[ctx.scope.workspaceId,actor.userId])).rows;
 if(rows.length>30)return {ok:false,reason:'account_limit_exceeded'};
 const runtime=(await ctx.db.query("SELECT 1 FROM social_publisher_runtime WHERE id='linkedin-web-chromium-v1' AND execution_side='worker' AND expires_at>clock_timestamp()")).rows.length===1;
 const accounts:SocialPublishingReadiness['accounts']=[];
 for(const row of rows){
  const holds:SocialPublishingReadinessHold[]=[];
  if(!runtime)holds.push('adapter_unavailable');
  const supported=row.platform==='linkedin'&&row.account_kind==='profile';
  if(!supported)holds.push('unsupported_route');
  let verified=false;
  if(publisher&&supported&&row.state==='connected'&&row.session_id&&row.session_revision&&row.session_account_revision===row.revision){
   const binding:SocialPublisherBinding={workspaceId:ctx.scope.workspaceId,ownerUserId:actor.userId,accountId:row.id,accountRevision:row.revision,sessionId:row.session_id,sessionRevision:row.session_revision,externalId:row.external_id};
   const result=await publisher.verify(binding);await requirePrivateDraftAuthority(authority);
   verified=result.usable&&result.externalId===row.external_id;
  }
  if(!verified)holds.push('current_account_unverified');
  if(configuration?.binding.accountId!==row.id||configuration.binding.accountRevision!==row.revision)holds.push('current_publication_policy_unavailable');
  accounts.push({accountId:row.id,revision:row.revision,platform:row.platform,accountKind:row.account_kind,displayName:row.display_name,historicalState:row.state,currentAccountVerified:verified,holds});
 }
 const at=(await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]?.now;
 if(!(at instanceof Date)||!Number.isFinite(at.getTime()))return {ok:false,reason:'observation_unavailable'};
 await requirePrivateDraftAuthority(authority);
 const holds:SocialPublishingReadinessHold[]=[];
 if(!runtime)holds.push('adapter_unavailable');if(!accounts.some(account=>account.currentAccountVerified))holds.push('current_account_unverified');
 if(!configuration)holds.push('current_publication_policy_unavailable');
 return {ok:true,value:socialPublishingReadinessSchema.parse({observedAt:at.toISOString(),runnerAvailable:runtime,publishingActivated:Boolean(configuration),holds,accounts})};
}
