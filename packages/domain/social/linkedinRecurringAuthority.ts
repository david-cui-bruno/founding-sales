import type {LinkedinPostingPolicySnapshot,SocialDraftRequest} from '@fss/contracts';
import {LINKEDIN_POSTING_RULES} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {postingSpend} from './draftRun.ts';
import {readResearchSettings} from '../research/settings.ts';
import {readCreditSpend,workspaceBusinessZone} from '../research/ledger.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {databaseNow} from '../policy/clock.ts';
import type {SocialDraftPort} from './draftRun.ts';
import {readSocialDraftSources,readSocialDraftSourcesForWorker} from './draftSources.ts';
import {REQUIRED_SCHEMA} from '../db/schemaRange.ts';
import {readAppliedSchemaVersion} from '../db/migrationRunner.ts';
export interface LinkedinRecurringComposition{
 readonly workspaceId:string;readonly ownerUserId:string;readonly accountId:string;readonly accountRevision:number;readonly policyRevision:number;
 readonly generation:NonNullable<LinkedinPostingPolicySnapshot['generation']>;readonly expiresAt:string;
 readonly databaseName:string;readonly serverAddress:string;readonly serverPort:number;readonly model:SocialDraftPort;
 readonly clock:{now():string};
}
export interface LinkedinRecurringSlot{[key:string]:unknown;id:string;owner_user_id:string;account_id:string;account_revision:number;policy_revision:number;target_at:Date;source_selection:SocialDraftRequest|null;source_hash:string|null;draft_request_id:string|null;post_id:string|null;state:string;reason:string|null}
export async function lockLinkedinRecurringOwner(ctx:RepositoryContext,owner:string):Promise<void>{
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-accounts:${ctx.scope.workspaceId}:${owner}`]);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`linkedin-posting-policy:${ctx.scope.workspaceId}:${owner}`]);
}
export async function linkedinRecurringScopeReason(ctx:RepositoryContext,slot:Pick<LinkedinRecurringSlot,'owner_user_id'|'account_id'|'account_revision'|'policy_revision'>,runtime?:LinkedinRecurringComposition|null):Promise<string|null>{
 await lockLinkedinRecurringOwner(ctx,slot.owner_user_id);
 const p=(await ctx.db.query<{revision:number;state:string;policy:LinkedinPostingPolicySnapshot}>(`SELECT s.revision,s.state,s.policy FROM linkedin_posting_settings s JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_user_id AND m.status='active' AND m.role='admin' WHERE s.workspace_id=$1 AND s.owner_user_id=$2 FOR SHARE OF s,m`,[ctx.scope.workspaceId,slot.owner_user_id])).rows[0];
 if(!p)return 'owner_or_policy_unavailable';
 if(p.state!=='saved')return `policy_${p.state}`;
 if(p.revision!==slot.policy_revision||p.policy.rules.version!==LINKEDIN_POSTING_RULES.version)return 'policy_changed';
 const a=(await ctx.db.query<{revision:number;external_id:string;platform:string;account_kind:string;state:string}>('SELECT revision,external_id,platform,account_kind,state FROM social_accounts WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR SHARE',[ctx.scope.workspaceId,slot.account_id,slot.owner_user_id])).rows[0];
 if(!a||a.state!=='connected')return 'account_unavailable';
 if(a.platform!=='linkedin'||a.account_kind!=='profile'||a.external_id!==LINKEDIN_POSTING_RULES.account||a.revision!==slot.account_revision||p.policy.accountId!==slot.account_id||p.policy.accountRevision!==a.revision||p.policy.accountExternalId!==a.external_id)return 'account_changed';
 if(!runtime||runtime.workspaceId!==ctx.scope.workspaceId||runtime.ownerUserId!==slot.owner_user_id||runtime.accountId!==slot.account_id||runtime.accountRevision!==a.revision||runtime.policyRevision!==p.revision||Date.parse(runtime.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(runtime.expiresAt)))return 'runtime_unavailable_or_expired';
 if(!p.policy.generation||Object.keys(p.policy.generation).length!==Object.keys(runtime.generation).length||Object.entries(runtime.generation).some(([key,value])=>Reflect.get(p.policy.generation!,key)!==value)||runtime.model.providerKey!==LINKEDIN_POSTING_RULES.generation.providerKey)return 'provider_or_data_binding_changed';
 const connection=(await ctx.db.query<{name:string;address:string;port:number;role:string}>('SELECT current_database() AS name,host(inet_server_addr()) AS address,inet_server_port() AS port,current_user AS role')).rows[0];
 if(connection?.name!==runtime.databaseName||connection.address!==runtime.serverAddress||connection.port!==runtime.serverPort||connection.role!=='app_runtime'||await readAppliedSchemaVersion(ctx.db)!==REQUIRED_SCHEMA)return 'runtime_database_changed';
 return null;
}
export async function linkedinRecurringSlotReason(ctx:RepositoryContext,slot:LinkedinRecurringSlot,runtime?:LinkedinRecurringComposition|null):Promise<string|null>{
 const scope=await linkedinRecurringScopeReason(ctx,slot,runtime);if(scope)return scope;
 const uncertain=(await ctx.db.query(`SELECT 1 FROM social_deliveries d JOIN social_post_revisions p ON p.workspace_id=d.workspace_id AND p.post_id=d.post_id AND p.revision=d.revision WHERE d.workspace_id=$1 AND p.account_id=$2 AND ($3::uuid IS NULL OR d.post_id<>$3) AND d.state IN ('submitting','unknown','cancellation_pending') LIMIT 1`,[ctx.scope.workspaceId,slot.account_id,slot.post_id])).rows.length;
 if(uncertain)return 'existing_submission_uncertain';
 if(!runtime||Date.parse(runtime.clock.now())>=slot.target_at.getTime()||Date.parse(runtime.clock.now())<slot.target_at.getTime()-1800000||!Number.isFinite(Date.parse(runtime.clock.now())))return 'slot_missed_or_not_due';
 if(!slot.source_selection||!slot.source_hash)return 'no_ready_input';
 // Actor stays worker. Owner is derived from the persisted slot, never a candidate or renderer.
 const source=ctx.scope.actor.kind==='user'?await readSocialDraftSources(ctx,slot.source_selection):await readSocialDraftSourcesForWorker(ctx,slot.owner_user_id,slot.source_selection);
 if(!source.ok||source.value.hash!==slot.source_hash)return 'source_changed_or_unavailable';
 // Fact/source share locks can wait. Observe funding only after those waits,
 // retaining the current settings row against ordinary settings updates.
 if(!(await ctx.db.query('SELECT 1 FROM research_settings WHERE workspace_id=$1 FOR SHARE',[ctx.scope.workspaceId])).rows.length)return 'funding_not_configured';
 const at=await databaseNow(ctx),settings=await readResearchSettings(ctx);
 if(!settings.enabled||(await listApplicableHolds(ctx,{actionKind:'research'})).length)return 'drafting_held';
 const shared=await readCreditSpend(ctx,{at,businessTimeZone:await workspaceBusinessZone(ctx)}),lane=await postingSpend(ctx,at);
 if(shared.todayCents>settings.dailyCostCeilingCents||shared.monthToDateCents>settings.monthlyCostCeilingCents||lane.today>100||lane.month>1000)return 'posting_or_shared_budget_changed';
 // No awaited read follows this same-observation time check.
 return runtime?linkedinRecurringDraftDeadlineReason({targetAt:slot.target_at.getTime(),expiresAt:Date.parse(runtime.expiresAt),clock:runtime.clock}):'runtime_unavailable_or_expired';
}
interface LinkedinRecurringDraftDeadline{readonly targetAt:number;readonly expiresAt:number;readonly clock:LinkedinRecurringComposition['clock']}
/** A captured deadline is only produced by the same canonical standing observation. */
export async function observeLinkedinRecurringDraft(ctx:RepositoryContext,id:string,runtime?:LinkedinRecurringComposition|null):Promise<{reason:string|null;deadline:LinkedinRecurringDraftDeadline|null}>{
 const s=(await ctx.db.query<LinkedinRecurringSlot>('SELECT * FROM linkedin_recurring_slots WHERE workspace_id=$1 AND draft_request_id=$2',[ctx.scope.workspaceId,id])).rows[0];
 if(!s)return {reason:null,deadline:null};
 const reason=await linkedinRecurringSlotReason(ctx,s,runtime);
 return {reason,deadline:reason||!runtime?null:{targetAt:s.target_at.getTime(),expiresAt:Date.parse(runtime.expiresAt),clock:runtime.clock}};
}
/** No database/provider wait can follow this check before the paid invocation. */
export function linkedinRecurringDraftDeadlineReason(deadline:LinkedinRecurringDraftDeadline|null):string|null{
 if(!deadline)return null; // Unbound manual drafting has no standing slot deadline.
 if(!Number.isFinite(deadline.expiresAt)||Date.now()>=deadline.expiresAt)return 'runtime_unavailable_or_expired';
 const at=Date.parse(deadline.clock.now());
 return !Number.isFinite(at)||at>=deadline.targetAt||at<deadline.targetAt-1800000?'slot_missed_or_not_due':null;
}
export async function checkLinkedinRecurringDraft(ctx:RepositoryContext,id:string,runtime?:LinkedinRecurringComposition|null):Promise<string|null>{
 return (await observeLinkedinRecurringDraft(ctx,id,runtime)).reason;
}
export async function checkLinkedinRecurringDelivery(ctx:RepositoryContext,by:'post_id'|'claim_id'|'id'|'submission_id',id:string,runtime?:LinkedinRecurringComposition|null):Promise<string|null>{
 const owner=ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;if(!owner)return 'owner_unavailable';
 const rows=(await ctx.db.query<{approval_kind:string;standing_slot_id:string|null}>(`SELECT a.approval_kind,a.standing_slot_id FROM social_deliveries d JOIN social_posts p ON p.workspace_id=d.workspace_id AND p.id=d.post_id JOIN social_post_approvals a ON a.workspace_id=d.workspace_id AND a.id=d.approval_id WHERE d.workspace_id=$1 AND d.${by}=$2 AND p.owner_user_id=$3 ORDER BY d.revision DESC LIMIT 1`,[ctx.scope.workspaceId,id,owner])).rows;
 const approval=rows[0];if(!approval||approval.approval_kind==='manual')return null;
 const s=(await ctx.db.query<LinkedinRecurringSlot>('SELECT * FROM linkedin_recurring_slots WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3',[ctx.scope.workspaceId,approval.standing_slot_id,owner])).rows[0];
 return s&&s.post_id&&s.state==='queued'?linkedinRecurringSlotReason(ctx,s,runtime):'standing_admission_unavailable';
}
