import {LINKEDIN_POSTING_RULES,linkedinPostingPolicySaveSchema,type LinkedinPostingPolicySave,type LinkedinPostingPolicyView,type LinkedinPostingPolicySnapshot,type LinkedinPostingPolicyCheck,type LinkedinPostingPolicyCurrent} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {lockSocialPost,readSocialPost,socialApprovalSnapshot,type SocialResult} from './posts.ts';
import type {LinkedinPostingCandidateBinding} from '@fss/contracts';
interface PolicyRow{[key:string]:unknown;revision:number;state:'saved'|'disabled'|'revoked';policy:LinkedinPostingPolicySnapshot}
const user=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
/** All callers use a transaction. Same account lock as connect/disconnect. */
async function lock(ctx:RepositoryContext,owner:string):Promise<void>{
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-accounts:${ctx.scope.workspaceId}:${owner}`]);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`linkedin-posting-policy:${ctx.scope.workspaceId}:${owner}`]);
}
async function activeOwner(ctx:RepositoryContext,owner:string):Promise<boolean>{return (await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[ctx.scope.workspaceId,owner])).rows.length>0;}
async function row(ctx:RepositoryContext,owner:string):Promise<PolicyRow|null>{return (await ctx.db.query<PolicyRow>('SELECT revision,state,policy FROM linkedin_posting_settings WHERE workspace_id=$1 AND owner_user_id=$2 FOR SHARE',[ctx.scope.workspaceId,owner])).rows[0]??null;}
function empty(hold='policy_not_saved'):LinkedinPostingPolicyView{return {accounts:[],revision:0,state:'not_saved',enabled:false,technicallyReady:false,policy:null,rules:LINKEDIN_POSTING_RULES,holds:[hold],history:[],candidates:[]};}
async function view(ctx:RepositoryContext,owner:string,r:PolicyRow|null):Promise<LinkedinPostingPolicyView>{
 const accounts=(await ctx.db.query<{id:string;externalId:string;displayName:string;revision:number;state:string}>(`SELECT id,external_id AS "externalId",display_name AS "displayName",revision,state FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND platform='linkedin' AND account_kind='profile' ORDER BY id FOR SHARE`,[ctx.scope.workspaceId,owner])).rows;
 if(!r)return {...empty(),accounts};
 const holds:string[]=[];
 if(r.state!=='saved')holds.push(`policy_${r.state}`);
 if(r.policy.rules.version!==LINKEDIN_POSTING_RULES.version)holds.push('policy_rules_changed');
 const a=accounts.find(a=>a.id===r.policy.accountId);
 if(!a||a.state!=='connected')holds.push('account_unavailable');
 if(a&&(a.revision!==r.policy.accountRevision||a.externalId!==r.policy.accountExternalId))holds.push('account_changed');
 if(!r.policy.generation)holds.push('generation_not_configured');
 else holds.push('provider_binding_unverified','configured_budget_unverified','available_allowance_unverified');
 holds.push('installed_identity_unverified','runtime_acceptance_pending','publication_not_enabled');
 const history=(await ctx.db.query<{revision:number;state:string;policy:LinkedinPostingPolicySnapshot;created_at:Date}>('SELECT revision,state,policy,created_at FROM linkedin_posting_policy_revisions WHERE workspace_id=$1 AND owner_user_id=$2 ORDER BY revision DESC LIMIT 25',[ctx.scope.workspaceId,owner])).rows.map(h=>({revision:h.revision,state:h.state,accountId:h.policy.accountId,accountRevision:h.policy.accountRevision,recordedAt:h.created_at.toISOString()}));
 const base:LinkedinPostingPolicyView={accounts,revision:r.revision,state:r.state,enabled:false,technicallyReady:false,policy:r.policy,rules:LINKEDIN_POSTING_RULES,holds,history,candidates:[]};
 const bindings=(await ctx.db.query<{post_id:string;revision:number;current_revision:number;policy_revision:number;state:string;policy:LinkedinPostingPolicySnapshot}>(`SELECT d.post_id,d.revision,p.current_revision,b.policy_revision,d.state,r.policy FROM linkedin_posting_candidate_bindings b JOIN social_deliveries d ON d.workspace_id=b.workspace_id AND d.id=b.delivery_id JOIN social_posts p ON p.workspace_id=d.workspace_id AND p.id=d.post_id AND p.owner_user_id=b.owner_user_id JOIN linkedin_posting_policy_revisions r ON r.workspace_id=b.workspace_id AND r.owner_user_id=b.owner_user_id AND r.revision=b.policy_revision WHERE b.workspace_id=$1 AND b.owner_user_id=$2 ORDER BY b.policy_revision DESC,d.id LIMIT 25`,[ctx.scope.workspaceId,owner])).rows;
 base.candidates=bindings.map(b=>{const check=current(base,{expectedRevision:b.policy_revision,accountId:b.policy.accountId,accountRevision:b.policy.accountRevision});const fresh=b.current_revision===b.revision;return {postId:b.post_id,postRevision:b.revision,policyRevision:b.policy_revision,current:fresh&&check.current,reason:fresh?check.reason:'stale_post_revision',submissionState:b.state};});
 return base;
}
export async function readLinkedinPostingPolicy(ctx:RepositoryContext):Promise<LinkedinPostingPolicyView>{
 const owner=user(ctx);if(!owner)return empty('owner_unavailable');
 await lock(ctx,owner);if(!await activeOwner(ctx,owner))return empty('owner_unavailable');
 return view(ctx,owner,await row(ctx,owner));
}
async function recordRevision(ctx:RepositoryContext,owner:string):Promise<void>{await ctx.db.query('INSERT INTO linkedin_posting_policy_revisions(workspace_id,owner_user_id,revision,state,policy) SELECT workspace_id,owner_user_id,revision,state,policy FROM linkedin_posting_settings WHERE workspace_id=$1 AND owner_user_id=$2',[ctx.scope.workspaceId,owner]);}
export async function saveLinkedinPostingPolicy(ctx:RepositoryContext,raw:LinkedinPostingPolicySave):Promise<SocialResult<LinkedinPostingPolicyView>>{
 const owner=user(ctx);if(!owner)return {ok:false,reason:'user_required'};
 const parsed=linkedinPostingPolicySaveSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};const input=parsed.data;
 await lock(ctx,owner);if(!await activeOwner(ctx,owner))return {ok:false,reason:'owner_unavailable'};
 const old=await row(ctx,owner);if((old?.revision??0)!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 const a=(await ctx.db.query<{revision:number;external_id:string;platform:string;account_kind:string}>('SELECT revision,external_id,platform,account_kind FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 FOR SHARE',[ctx.scope.workspaceId,owner,input.accountId])).rows[0];
 if(!a||a.platform!=='linkedin'||a.account_kind!=='profile')return {ok:false,reason:'account_not_found'};
 if(a.external_id!==LINKEDIN_POSTING_RULES.account)return {ok:false,reason:'account_identity_mismatch'};
 if(a.revision!==input.accountRevision)return {ok:false,reason:'account_changed'};
 const policy:LinkedinPostingPolicySnapshot={accountId:input.accountId,accountRevision:a.revision,accountExternalId:a.external_id,generation:input.generation,rules:LINKEDIN_POSTING_RULES};
 await ctx.db.query(`INSERT INTO linkedin_posting_settings(workspace_id,owner_user_id,revision,state,policy) VALUES($1,$2,1,'saved',$3::jsonb) ON CONFLICT(workspace_id,owner_user_id) DO UPDATE SET revision=linkedin_posting_settings.revision+1,state='saved',policy=$3::jsonb,updated_at=clock_timestamp()`,[ctx.scope.workspaceId,owner,JSON.stringify(policy)]);
 await recordRevision(ctx,owner);
 await recordCrmAuditEvent(ctx,{action:'linkedin.posting_policy_saved',subjectKind:'linkedin_posting_policy',subjectId:owner,detail:{revision:input.expectedRevision+1,accountId:input.accountId,accountRevision:a.revision,rulesVersion:LINKEDIN_POSTING_RULES.version}});
 return {ok:true,value:await view(ctx,owner,await row(ctx,owner))};
}
export async function stopLinkedinPostingPolicy(ctx:RepositoryContext,input:{expectedRevision:number},state:'disabled'|'revoked'):Promise<SocialResult<LinkedinPostingPolicyView>>{
 const owner=user(ctx);if(!owner)return {ok:false,reason:'user_required'};
 await lock(ctx,owner);if(!await activeOwner(ctx,owner))return {ok:false,reason:'owner_unavailable'};
 const old=await row(ctx,owner);if(!old)return {ok:false,reason:'policy_not_saved'};
 if(old.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 await ctx.db.query('UPDATE linkedin_posting_settings SET revision=revision+1,state=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND owner_user_id=$2',[ctx.scope.workspaceId,owner,state]);
 await recordRevision(ctx,owner);
 await recordCrmAuditEvent(ctx,{action:`linkedin.posting_policy_${state}`,subjectKind:'linkedin_posting_policy',subjectId:owner,detail:{revision:old.revision+1}});
 return {ok:true,value:await view(ctx,owner,await row(ctx,owner))};
}
function current(v:LinkedinPostingPolicyView,input:LinkedinPostingPolicyCheck):LinkedinPostingPolicyCurrent{
 let reason='current_policy_not_dispatch_authority';
 if(v.holds.includes('owner_unavailable'))reason='owner_unavailable';
 else if(v.state!=='saved')reason=`policy_${v.state}`;
 else if(v.revision!==input.expectedRevision)reason='stale_revision';
 else if(v.holds.includes('policy_rules_changed'))reason='policy_rules_changed';
 else if(v.holds.includes('account_changed')||v.policy?.accountId!==input.accountId||v.policy.accountRevision!==input.accountRevision)reason='account_changed';
 else if(v.holds.includes('account_unavailable'))reason='account_unavailable';
 return {current:reason==='current_policy_not_dispatch_authority',allowed:false,revision:v.revision,reason};
}
/** Current business scope, never actual publication readiness. */
export async function checkLinkedinPostingPolicyCurrent(ctx:RepositoryContext,input:LinkedinPostingPolicyCheck):Promise<LinkedinPostingPolicyCurrent>{return current(await readLinkedinPostingPolicy(ctx),input);}
/** Owner staging adds a stop fence to an existing human-approved delivery. It
 * neither creates an approval nor certifies a draft or automatic publication. */
export async function bindLinkedinPostingCandidate(ctx:RepositoryContext,input:{postId:string;postRevision:number;expectedRevision:number}):Promise<SocialResult<LinkedinPostingCandidateBinding>>{
 const owner=user(ctx);if(!owner)return {ok:false,reason:'user_required'};
 const v=await readLinkedinPostingPolicy(ctx);
 if(!v.policy)return {ok:false,reason:v.holds[0]??'policy_not_saved'};
 const check=current(v,{expectedRevision:input.expectedRevision,accountId:v.policy.accountId,accountRevision:v.policy.accountRevision});
 if(!check.current)return {ok:false,reason:check.reason};
 const rev=await lockSocialPost(ctx,input.postId);if(rev===null)return {ok:false,reason:'not_found'};
 if(rev!==input.postRevision)return {ok:false,reason:'stale_post_revision'};
 const p=(await readSocialPost(ctx,input.postId))!;
 if(p.accountId!==v.policy.accountId||p.images.length>0)return {ok:false,reason:'posting_scope_mismatch'};
 if(p.state!=='approved')return {ok:false,reason:'manual_approval_required'};
 const d=(await ctx.db.query<{id:string;submission_id:string|null;state:string;fingerprint:string}>(`SELECT d.id,d.submission_id,d.state,a.fingerprint FROM social_deliveries d JOIN social_post_approvals a ON a.workspace_id=d.workspace_id AND a.id=d.approval_id WHERE d.workspace_id=$1 AND d.post_id=$2 AND d.revision=$3 FOR SHARE OF d`,[ctx.scope.workspaceId,input.postId,rev])).rows[0];
 if(!d)return {ok:false,reason:'manual_approval_required'};
 if(d.submission_id!==null||d.state!=='pending')return {ok:false,reason:'inspect_existing_submission'};
 const snapshot=await socialApprovalSnapshot(ctx,p);if(!snapshot.ok)return snapshot;
 if(snapshot.value.fingerprint!==d.fingerprint)return {ok:false,reason:'approval_changed'};
 const old=(await ctx.db.query<{policy_revision:number}>('SELECT policy_revision FROM linkedin_posting_candidate_bindings WHERE workspace_id=$1 AND delivery_id=$2',[ctx.scope.workspaceId,d.id])).rows[0];
 if(old)return {ok:false,reason:'candidate_already_bound'};
 await ctx.db.query('INSERT INTO linkedin_posting_candidate_bindings(workspace_id,delivery_id,owner_user_id,policy_revision) VALUES($1,$2,$3,$4)',[ctx.scope.workspaceId,d.id,owner,v.revision]);
 await recordCrmAuditEvent(ctx,{action:'linkedin.posting_candidate_bound',subjectKind:'social_post',subjectId:input.postId,detail:{postRevision:rev,policyRevision:v.revision}});
 return {ok:true,value:{postId:input.postId,postRevision:rev,policyRevision:v.revision,current:true,publicationReady:false}};
}
/** Account/policy serialization precedes binding discovery and post locks, so
 * a concurrent owner bind cannot slip between discovery and delivery admission.
 * Attempted actions retain inspection. Null preserves unbound manual gates. */
export async function checkLinkedinPostingDelivery(ctx:RepositoryContext,by:'post_id'|'claim_id'|'id',id:string):Promise<string|null>{
 const owner=user(ctx);if(!owner)return 'owner_unavailable';
 await lock(ctx,owner);
 const binding=(await ctx.db.query<{policy_revision:number;accountId:string;accountRevision:number}>(`SELECT b.policy_revision,r.policy->>'accountId' AS "accountId",(r.policy->>'accountRevision')::integer AS "accountRevision" FROM social_deliveries d JOIN social_posts p ON p.workspace_id=d.workspace_id AND p.id=d.post_id JOIN linkedin_posting_candidate_bindings b ON b.workspace_id=d.workspace_id AND b.delivery_id=d.id AND b.owner_user_id=p.owner_user_id JOIN linkedin_posting_policy_revisions r ON r.workspace_id=b.workspace_id AND r.owner_user_id=b.owner_user_id AND r.revision=b.policy_revision WHERE d.workspace_id=$1 AND d.${by}=$2 AND p.owner_user_id=$3 AND d.submission_id IS NULL ORDER BY d.revision DESC LIMIT 1`,[ctx.scope.workspaceId,id,owner])).rows[0];
 if(!binding)return null;
 const check=await checkLinkedinPostingPolicyCurrent(ctx,{expectedRevision:binding.policy_revision,accountId:binding.accountId,accountRevision:binding.accountRevision});
 return check.current?null:check.reason;
}
export async function linkedinPostingBindingRequired(ctx:RepositoryContext,deliveryId:string):Promise<boolean>{return (await ctx.db.query('SELECT 1 FROM linkedin_posting_candidate_bindings b JOIN social_deliveries d ON d.workspace_id=b.workspace_id AND d.id=b.delivery_id JOIN social_posts p ON p.workspace_id=d.workspace_id AND p.id=d.post_id WHERE b.workspace_id=$1 AND b.delivery_id=$2 AND b.owner_user_id=$3 AND p.owner_user_id=$3',[ctx.scope.workspaceId,deliveryId,user(ctx)])).rows.length>0;}
/** Final admission check after begin's network wait. Never mutates its marker.
 * This is not an atomic external-click lease and never authorizes a replay. */
export async function checkLinkedinPostingDispatch(ctx:RepositoryContext,input:{submissionId:string;deviceId:string}):Promise<{current:boolean;reason:string}>{
 const owner=user(ctx);if(!owner)return {current:false,reason:'owner_unavailable'};
 await lock(ctx,owner);if(!await activeOwner(ctx,owner))return {current:false,reason:'owner_unavailable'};
 const d=(await ctx.db.query<{state:string;revision:number;current_revision:number;receipt_id:string|null;policy_revision:number|null;policy:LinkedinPostingPolicySnapshot|null}>(`SELECT d.state,d.revision,p.current_revision,d.receipt_id,b.policy_revision,r.policy FROM social_deliveries d JOIN social_posts p ON p.workspace_id=d.workspace_id AND p.id=d.post_id JOIN devices v ON v.workspace_id=d.workspace_id AND v.id=d.device_id AND v.user_id=p.owner_user_id AND v.status='active' LEFT JOIN linkedin_posting_candidate_bindings b ON b.workspace_id=d.workspace_id AND b.delivery_id=d.id AND b.owner_user_id=p.owner_user_id LEFT JOIN linkedin_posting_policy_revisions r ON r.workspace_id=b.workspace_id AND r.owner_user_id=b.owner_user_id AND r.revision=b.policy_revision WHERE d.workspace_id=$1 AND d.submission_id=$2 AND d.device_id=$3 AND p.owner_user_id=$4`,[ctx.scope.workspaceId,input.submissionId,input.deviceId,owner])).rows[0];
 if(!d||d.state!=='submitting'||d.receipt_id!==null||d.revision!==d.current_revision)return {current:false,reason:'inspect_existing_submission'};
 if(d.policy_revision===null)return {current:true,reason:'current_existing_manual_submission'};
 if(!d.policy)return {current:false,reason:'binding_unavailable'};
 const check=current(await view(ctx,owner,await row(ctx,owner)),{expectedRevision:d.policy_revision,accountId:d.policy.accountId,accountRevision:d.policy.accountRevision});
 return {current:check.current,reason:check.reason};
}
