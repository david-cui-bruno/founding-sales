import {socialPublishingReadinessSchema,type SocialPublishingReadiness,type SocialPublishingReadinessHold} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {requirePrivateDraftAuthority,type PrivateDraftAuthority} from './privateDrafts.ts';
import type {SocialResult} from './posts.ts';

interface Account extends Record<string,unknown>{
 id:string;revision:number;platform:'linkedin'|'facebook'|'x';account_kind:'profile'|'page';
 display_name:string;state:'connected'|'reconnect'|'unsupported'|'disconnected';
}
const blocked:SocialPublishingReadinessHold[]=[
 'adapter_unavailable','current_account_unverified','current_publication_policy_unavailable',
];
/** Caller owns the read transaction. Membership/account locks keep this metadata
 * stable through final principal checks. No provider, account or policy is changed. */
export async function readSocialPublishingReadiness(
 ctx:RepositoryContext,authority:PrivateDraftAuthority,
):Promise<SocialResult<SocialPublishingReadiness>>{
 const actor=ctx.scope.actor;
 if(actor.kind!=='user'||actor.role!=='admin')return {ok:false,reason:'admin_required'};
 const active=(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role='admin' AND status='active' FOR SHARE",[ctx.scope.workspaceId,actor.userId])).rows.length===1;
 if(!active)return {ok:false,reason:'owner_unavailable'};
 await requirePrivateDraftAuthority(authority);
 const rows=(await ctx.db.query<Account>(`SELECT id,revision,platform,account_kind,display_name,state FROM social_accounts
  WHERE workspace_id=$1 AND owner_user_id=$2 ORDER BY id LIMIT 31 FOR SHARE`,[ctx.scope.workspaceId,actor.userId])).rows;
 if(rows.length>30)return {ok:false,reason:'account_limit_exceeded'};
 const at=(await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]?.now;
 if(!(at instanceof Date)||!Number.isFinite(at.getTime()))return {ok:false,reason:'observation_unavailable'};
 await requirePrivateDraftAuthority(authority);
 return {ok:true,value:socialPublishingReadinessSchema.parse({
  observedAt:at.toISOString(),runnerAvailable:false,publishingActivated:false,holds:[...blocked],
  accounts:rows.map(row=>({accountId:row.id,revision:row.revision,platform:row.platform,accountKind:row.account_kind,
   displayName:row.display_name,historicalState:row.state,currentAccountVerified:false,
   holds:row.platform==='linkedin'&&row.account_kind==='profile'?[...blocked]:[...blocked,'unsupported_route'],
  })),
 })};
}
