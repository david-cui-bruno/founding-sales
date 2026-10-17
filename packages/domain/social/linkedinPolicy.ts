import {
 LINKEDIN_OUTREACH_RULES, linkedinPolicySaveSchema, linkedinPolicyWorkBindingSchema,
 type LinkedinPolicySave, type LinkedinPolicyView, type LinkedinPolicySnapshot,
 type LinkedinPolicyHold, type LinkedinPolicyCheck, type LinkedinPolicyCurrent,
 type LinkedinPolicyWorkBinding, type LinkedinPolicyWorkCurrent, type LinkedinPolicyAccount,
} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import type {SocialResult} from './posts.ts';

interface PolicyRow {
 [key:string]:unknown;
 revision:number;
 state:'saved'|'disabled'|'revoked';
 approved:boolean;
 approved_at:Date|null;
 policy:LinkedinPolicySnapshot;
}
interface AccountRow {
 [key:string]:unknown;
 revision:number;
 external_id:string;
 state:string;
 platform:string;
 account_kind:string;
}
const user=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;

/** Same account lock as normal connect/disconnect, then the narrow policy lock.
 * Every exported operation requires a transaction, including after-wait checks. */
async function lock(ctx:RepositoryContext,owner:string):Promise<void>{
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-accounts:${ctx.scope.workspaceId}:${owner}`]);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`linkedin-policy:${ctx.scope.workspaceId}:${owner}`]);
}
async function activeOwner(ctx:RepositoryContext,owner:string):Promise<boolean>{
 return (await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[ctx.scope.workspaceId,owner])).rows.length>0;
}
async function row(ctx:RepositoryContext,owner:string):Promise<PolicyRow|null>{
 return (await ctx.db.query<PolicyRow>('SELECT * FROM linkedin_outreach_settings WHERE workspace_id=$1 AND owner_user_id=$2 FOR SHARE',[ctx.scope.workspaceId,owner])).rows[0]??null;
}
async function account(ctx:RepositoryContext,owner:string,id:string):Promise<AccountRow|null>{
 return (await ctx.db.query<AccountRow>('SELECT revision,external_id,state,platform,account_kind FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 FOR SHARE',[ctx.scope.workspaceId,owner,id])).rows[0]??null;
}
function empty(hold:LinkedinPolicyHold='policy_not_saved'):LinkedinPolicyView{
 return {accounts:[],revision:0,state:'not_saved',rules:LINKEDIN_OUTREACH_RULES,enabled:false,technicallyReady:false,approved:false,approvedAt:null,policy:null,holds:[hold]};
}
/** Owner membership is already checked and share-locked for this transaction. */
async function view(ctx:RepositoryContext,owner:string,r:PolicyRow|null):Promise<LinkedinPolicyView>{
 const accounts=(await ctx.db.query<{id:string;external_id:string;display_name:string;revision:number;state:LinkedinPolicyAccount['state']}>("SELECT id,external_id,display_name,revision,state FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND platform='linkedin' AND account_kind='profile' ORDER BY id FOR SHARE",[ctx.scope.workspaceId,owner])).rows.map(a=>({id:a.id,externalId:a.external_id,displayName:a.display_name,revision:a.revision,state:a.state,identityVerified:false as const}));
 if(!r)return {...empty(),accounts};
 const holds:LinkedinPolicyHold[]=[];
 if(r.state==='disabled')holds.push('policy_disabled');
 if(r.state==='revoked')holds.push('policy_revoked');
 if(!r.approved)holds.push('owner_approval_required');
 if(r.policy.rules.version!==LINKEDIN_OUTREACH_RULES.version)holds.push('policy_rules_changed');
 const a=await account(ctx,owner,r.policy.accountId);
 if(!a||a.state!=='connected'||a.platform!=='linkedin'||a.account_kind!=='profile')holds.push('account_unavailable');
 if(a&&(a.revision!==r.policy.accountRevision||a.external_id!==r.policy.accountExternalId))holds.push('account_changed');
 if(r.policy.dataScope===null)holds.push('data_scope_unknown');
 if(r.policy.acquisitionBinding===null)holds.push('acquisition_binding_unknown');
 if(r.policy.generation===null)holds.push('generation_not_configured');
 else holds.push('provider_binding_unverified','spend_evidence_unavailable');
 // Posting's connected/verified flag and owner-supplied settings prove neither
 // current native outreach identity/coverage nor real model or voice acceptance.
 holds.push('exact_identity_unverified','acquisition_evidence_unavailable','manual_count_coverage_unavailable','reply_history_coverage_unavailable','voice_calibration_unverified','outreach_adapter_unavailable');
 return {accounts,revision:r.revision,state:r.state,rules:LINKEDIN_OUTREACH_RULES,enabled:false,technicallyReady:false,approved:r.approved,approvedAt:r.approved_at?.toISOString()??null,policy:r.policy,holds};
}
async function readForOwner(ctx:RepositoryContext,owner:string):Promise<LinkedinPolicyView>{
 await lock(ctx,owner);
 // Authentication may have happened before a lock/external wait. Never disclose
 // private account/provider settings after the owner leaves the workspace.
 if(!await activeOwner(ctx,owner))return empty('owner_unavailable');
 return view(ctx,owner,await row(ctx,owner));
}
/** Ordinary owner settings read. The owner comes only from authenticated scope. */
export async function readLinkedinPolicy(ctx:RepositoryContext):Promise<LinkedinPolicyView>{
 const owner=user(ctx);
 return owner?readForOwner(ctx,owner):empty('owner_unavailable');
}
async function recordRevision(ctx:RepositoryContext,owner:string):Promise<void>{
 await ctx.db.query('INSERT INTO linkedin_outreach_policy_revisions(workspace_id,owner_user_id,revision,state,approved,approved_at,policy) SELECT workspace_id,owner_user_id,revision,state,approved,approved_at,policy FROM linkedin_outreach_settings WHERE workspace_id=$1 AND owner_user_id=$2',[ctx.scope.workspaceId,owner]);
}
export async function saveLinkedinPolicy(ctx:RepositoryContext,raw:LinkedinPolicySave):Promise<SocialResult<LinkedinPolicyView>>{
 const owner=user(ctx);
 if(!owner)return {ok:false,reason:'user_required'};
 const parsed=linkedinPolicySaveSchema.safeParse(raw);
 if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const input=parsed.data;
 await lock(ctx,owner);
 if(!await activeOwner(ctx,owner))return {ok:false,reason:'owner_unavailable'};
 const old=await row(ctx,owner);
 if((old?.revision??0)!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 const a=await account(ctx,owner,input.accountId);
 if(!a||a.platform!=='linkedin'||a.account_kind!=='profile')return {ok:false,reason:'account_not_found'};
 if(a.revision!==input.accountRevision)return {ok:false,reason:'account_changed'};
 const policy:LinkedinPolicySnapshot={accountId:input.accountId,accountRevision:a.revision,accountExternalId:a.external_id,dataScope:input.dataScope,acquisitionBinding:input.acquisitionBinding,generation:input.generation,rules:LINKEDIN_OUTREACH_RULES};
 await ctx.db.query(`INSERT INTO linkedin_outreach_settings(workspace_id,owner_user_id,revision,state,approved,approved_at,policy) VALUES($1,$2,1,'saved',true,clock_timestamp(),$3::jsonb)
 ON CONFLICT(workspace_id,owner_user_id) DO UPDATE SET revision=linkedin_outreach_settings.revision+1,state='saved',approved=true,approved_at=clock_timestamp(),policy=$3::jsonb,updated_at=clock_timestamp()`,[ctx.scope.workspaceId,owner,JSON.stringify(policy)]);
 await recordRevision(ctx,owner);
 await recordCrmAuditEvent(ctx,{action:'linkedin.policy_saved',subjectKind:'linkedin_policy',subjectId:owner,detail:{revision:input.expectedRevision+1,accountId:input.accountId,accountRevision:a.revision,rulesVersion:LINKEDIN_OUTREACH_RULES.version}});
 return {ok:true,value:await view(ctx,owner,await row(ctx,owner))};
}
export async function stopLinkedinPolicy(ctx:RepositoryContext,input:{expectedRevision:number},state:'disabled'|'revoked'):Promise<SocialResult<LinkedinPolicyView>>{
 const owner=user(ctx);
 if(!owner)return {ok:false,reason:'user_required'};
 await lock(ctx,owner);
 if(!await activeOwner(ctx,owner))return {ok:false,reason:'owner_unavailable'};
 const old=await row(ctx,owner);
 if(!old)return {ok:false,reason:'policy_not_saved'};
 if(old.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 await ctx.db.query('UPDATE linkedin_outreach_settings SET revision=revision+1,state=$3,approved=false,approved_at=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND owner_user_id=$2',[ctx.scope.workspaceId,owner,state]);
 await recordRevision(ctx,owner);
 await recordCrmAuditEvent(ctx,{action:`linkedin.policy_${state}`,subjectKind:'linkedin_policy',subjectId:owner,detail:{revision:old.revision+1}});
 return {ok:true,value:await view(ctx,owner,await row(ctx,owner))};
}
function currentReason(v:LinkedinPolicyView,input:LinkedinPolicyCheck):string{
 if(v.holds.includes('owner_unavailable'))return 'owner_unavailable';
 if(v.revision!==input.expectedRevision)return 'stale_revision';
 if(v.state!=='saved')return `policy_${v.state}`;
 if(!v.approved)return 'owner_approval_required';
 if(v.holds.includes('policy_rules_changed'))return 'policy_rules_changed';
 if(v.holds.includes('account_unavailable'))return 'account_unavailable';
 if(v.holds.includes('account_changed')||v.policy?.accountId!==input.accountId||v.policy?.accountRevision!==input.accountRevision)return 'account_changed';
 return 'current_approval_not_dispatch_authority';
}
function currentView(v:LinkedinPolicyView,input:LinkedinPolicyCheck):LinkedinPolicyCurrent{
 const reason=currentReason(v,input);
 return {current:reason==='current_approval_not_dispatch_authority',allowed:false,revision:v.revision,reason,holds:v.holds};
}
/** Revision/account barrier for queued consumers and after external waits/restart.
 * A current approval is NOT dispatch permission. Runtime consumers separately
 * check source access/deletion, native/model/count/spend evidence and actual
 * Enable. Accepted observations and incurred charges are never erased here. */
export async function checkLinkedinPolicyCurrent(ctx:RepositoryContext,input:LinkedinPolicyCheck):Promise<LinkedinPolicyCurrent>{
 return currentView(await readLinkedinPolicy(ctx),input);
}
/** Trusted worker-only seam. ownerUserId comes from the consumer's durable work
 * binding, not a client request or synthetic user actor. Shares all owner/account
 * locks and access checks with normal commands. Check again after every wait. */
export async function checkLinkedinPolicyForWork(ctx:RepositoryContext,binding:LinkedinPolicyWorkBinding):Promise<LinkedinPolicyWorkCurrent>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')throw new Error('worker_required');
 const parsed=linkedinPolicyWorkBindingSchema.safeParse(binding);
 if(!parsed.success)throw new Error('invalid_work_binding');
 const v=await readForOwner(ctx,parsed.data.ownerUserId);
 const current=currentView(v,parsed.data);
 return {...current,policy:current.current?v.policy:null};
}
