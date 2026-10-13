import {randomUUID} from 'node:crypto';
import type {LinkedinPostingPolicySnapshot,LinkedinRecurringView,PostRevision,SocialDraftRequest} from '@fss/contracts';
import {linkedinRecurringViewSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import {readSocialDraftSourcesForWorker} from './draftSources.ts';
import {GROUNDED_SOCIAL_DRAFT_PROMPT_VERSION,SOCIAL_DRAFT_MODEL,validateSocialDrafts} from './draftPolicy.ts';
import {runSocialDraft} from './draftRun.ts';
import type {SocialDraftRow} from './drafts.ts';
import {socialApprovalSnapshotForWorker} from './posts.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {linkedinRecurringDay} from './linkedinRecurringCalendar.ts';
import {lockLinkedinRecurringOwner,linkedinRecurringSlotReason,linkedinRecurringScopeReason,type LinkedinRecurringComposition,type LinkedinRecurringSlot} from './linkedinRecurringAuthority.ts';

export async function prepareLinkedinRecurringSlots(ctx:RepositoryContext,at:string,runtime?:LinkedinRecurringComposition|null):Promise<LinkedinRecurringSlot[]>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='scheduler')throw new Error('scheduler_required');
 const day=linkedinRecurringDay(at);if(!day||(!day.preparing&&!day.missed))return [];
 const owners=(await ctx.db.query<{owner_user_id:string;revision:number;policy:LinkedinPostingPolicySnapshot}>("SELECT owner_user_id,revision,policy FROM linkedin_posting_settings WHERE workspace_id=$1 AND state='saved' ORDER BY owner_user_id",[ctx.scope.workspaceId])).rows;
 for(const owner of owners){
  await lockLinkedinRecurringOwner(ctx,owner.owner_user_id);
  const exists=(await ctx.db.query('SELECT 1 FROM linkedin_recurring_slots WHERE workspace_id=$1 AND account_id=$2 AND target_at=$3',[ctx.scope.workspaceId,owner.policy.accountId,day.targetAt])).rows.length;if(exists)continue;
  const scope={owner_user_id:owner.owner_user_id,account_id:owner.policy.accountId,account_revision:owner.policy.accountRevision,policy_revision:owner.revision};
  let reason=day.missed?'slot_missed':await linkedinRecurringScopeReason(ctx,scope,runtime);
  const refs=(await ctx.db.query<{id:string;version:number}>(`SELECT b.id,b.current_version AS version FROM outreach_answer_blocks b JOIN outreach_answer_block_versions v ON v.workspace_id=b.workspace_id AND v.block_id=b.id AND v.version=b.current_version WHERE b.workspace_id=$1 AND v.approved_at IS NOT NULL AND v.retired_at IS NULL AND v.social_input IS NOT NULL ORDER BY v.approved_at DESC,b.id LIMIT 1`,[ctx.scope.workspaceId])).rows;
  const selection:SocialDraftRequest={mode:'linkedin_grounded',sourceRefs:[],factBlocks:refs};
  const prepared=refs.length?await readSocialDraftSourcesForWorker(ctx,owner.owner_user_id,selection):null;
  if(!reason&&(!prepared||!prepared.ok))reason=prepared&&!prepared.ok?prepared.reason:'no_ready_input';
  const uncertain=(await ctx.db.query(`SELECT 1 FROM social_deliveries d JOIN social_post_revisions p ON p.workspace_id=d.workspace_id AND p.post_id=d.post_id AND p.revision=d.revision WHERE d.workspace_id=$1 AND p.account_id=$2 AND d.state IN ('submitting','unknown','cancellation_pending') LIMIT 1`,[ctx.scope.workspaceId,scope.account_id])).rows.length;
  if(!reason&&uncertain)reason='existing_submission_uncertain';
  let requestId:string|null=null;
  if(!reason&&prepared?.ok){
   const busy=(await ctx.db.query("SELECT 1 FROM social_draft_requests WHERE workspace_id=$1 AND owner_user_id=$2 AND source_hash=$3 AND prompt_version=$4 AND state IN ('queued','calling')",[ctx.scope.workspaceId,owner.owner_user_id,prepared.value.hash,GROUNDED_SOCIAL_DRAFT_PROMPT_VERSION])).rows.length;
   if(busy)reason='draft_already_pending';
   else requestId=(await ctx.db.query<{id:string}>(`INSERT INTO social_draft_requests(workspace_id,owner_user_id,source_selection,source_hash,prompt_version,model_name) VALUES($1,$2,$3::jsonb,$4,$5,$6) RETURNING id`,[ctx.scope.workspaceId,owner.owner_user_id,JSON.stringify(selection),prepared.value.hash,GROUNDED_SOCIAL_DRAFT_PROMPT_VERSION,SOCIAL_DRAFT_MODEL])).rows[0]!.id;
  }
  await ctx.db.query(`INSERT INTO linkedin_recurring_slots(workspace_id,owner_user_id,account_id,account_revision,policy_revision,target_at,source_selection,source_hash,draft_request_id,state,reason) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) ON CONFLICT(workspace_id,account_id,target_at) DO NOTHING`,[ctx.scope.workspaceId,owner.owner_user_id,scope.account_id,scope.account_revision,scope.policy_revision,day.targetAt,prepared?.ok?JSON.stringify(selection):null,prepared?.ok?prepared.value.hash:null,requestId,reason?'skipped':'pending',reason]);
 }
 return (await ctx.db.query<LinkedinRecurringSlot>("SELECT s.* FROM linkedin_recurring_slots s JOIN social_draft_requests r ON r.workspace_id=s.workspace_id AND r.id=s.draft_request_id WHERE s.workspace_id=$1 AND s.target_at=$2 AND s.state='pending' AND r.state IN ('queued','ready') ORDER BY s.id",[ctx.scope.workspaceId,day.targetAt])).rows;
}

export async function runLinkedinRecurringSlot(ctx:RepositoryContext,id:string,runtime?:LinkedinRecurringComposition|null):Promise<void>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')throw new Error('worker_required');
 const db=ctx.db as SessionQueryable;
 const read=async()=> (await db.query<LinkedinRecurringSlot>('SELECT * FROM linkedin_recurring_slots WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id])).rows[0];
 const initial=await read();if(!initial||initial.state!=='pending'||!initial.draft_request_id)return;
 const reason=await withTransaction(db,()=>linkedinRecurringSlotReason(ctx,initial,runtime));
 if(reason){await db.query("UPDATE linkedin_recurring_slots SET state='skipped',reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending'",[ctx.scope.workspaceId,id,reason]);return;}
 await runSocialDraft(ctx,initial.draft_request_id,runtime?.model??null,runtime);
 await withTransaction(db,async()=>{
  // Same account -> policy -> membership/source -> post order as existing owner delivery gates.
  await lockLinkedinRecurringOwner(ctx,initial.owner_user_id);
  const slot=(await db.query<LinkedinRecurringSlot>("SELECT * FROM linkedin_recurring_slots WHERE workspace_id=$1 AND id=$2 AND state='pending' FOR UPDATE",[ctx.scope.workspaceId,id])).rows[0];if(!slot)return;
  const fresh=await linkedinRecurringSlotReason(ctx,slot,runtime);
  const draft=(await db.query<SocialDraftRow>('SELECT * FROM social_draft_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,slot.draft_request_id])).rows[0];
  const stop=async(state:'skipped'|'review',why:string)=>{await db.query('UPDATE linkedin_recurring_slots SET state=$3,reason=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id,state,why]);};
  if(fresh){await stop('skipped',fresh);return;}
  if(!draft||draft.state==='review'||draft.state==='expired'){await stop('review',draft?.reason??'draft_unavailable');return;}
  if(draft.state!=='ready'||!draft.concepts)return;
  const source=await readSocialDraftSourcesForWorker(ctx,slot.owner_user_id,slot.source_selection!);
  if(!source.ok||source.value.hash!==draft.source_hash||source.value.hash!==slot.source_hash){await stop('review','source_changed_or_unavailable');return;}
  const concepts=validateSocialDrafts(JSON.stringify({concepts:draft.concepts}),source.value.input);
  if(!concepts||concepts.length!==1||concepts[0]!.variants.length!==1||concepts[0]!.variants[0]!.platform!=='linkedin'){await stop('review','draft_needs_review');return;}
  const postId=randomUUID();
  await db.query('INSERT INTO social_posts(workspace_id,id,owner_user_id) VALUES($1,$2,$3)',[ctx.scope.workspaceId,postId,slot.owner_user_id]);
  const post:PostRevision={postId,revision:1,accountId:slot.account_id,text:concepts[0]!.variants[0]!.text,images:[],publishAt:slot.target_at.toISOString(),zone:'America/New_York',state:'draft',reason:null};
  await db.query("INSERT INTO social_post_revisions(workspace_id,post_id,revision,account_id,text,images,publish_at,zone) VALUES($1,$2,1,$3,$4,'[]',$5,$6)",[ctx.scope.workspaceId,postId,post.accountId,post.text,post.publishAt,post.zone]);
  const checked=await socialApprovalSnapshotForWorker(ctx,post,slot.owner_user_id);
  if(!checked.ok)throw new Error(`standing_snapshot_${checked.reason}`);
  await db.query('UPDATE linkedin_recurring_slots SET post_id=$3,state=\'queued\',reason=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id,postId]);
  const approvalId=randomUUID();
  await db.query("INSERT INTO social_post_approvals(workspace_id,id,post_id,revision,account_revision,fingerprint,snapshot,approved_by,approval_kind,standing_slot_id) VALUES($1,$2,$3,1,$4,$5,$6::jsonb,NULL,'standing_policy',$7)",[ctx.scope.workspaceId,approvalId,postId,slot.account_revision,checked.value.fingerprint,JSON.stringify(checked.value.snapshot),id]);
  const delivery=(await db.query<{id:string}>('INSERT INTO social_deliveries(workspace_id,post_id,revision,approval_id) VALUES($1,$2,1,$3) RETURNING id',[ctx.scope.workspaceId,postId,approvalId])).rows[0]!;
  await db.query('INSERT INTO linkedin_posting_candidate_bindings(workspace_id,delivery_id,owner_user_id,policy_revision) VALUES($1,$2,$3,$4)',[ctx.scope.workspaceId,delivery.id,slot.owner_user_id,slot.policy_revision]);
  await db.query("UPDATE social_post_revisions SET state='approved' WHERE workspace_id=$1 AND post_id=$2 AND revision=1",[ctx.scope.workspaceId,postId]);
  await recordCrmAuditEvent(ctx,{action:'linkedin.recurring_admitted',subjectKind:'social_post',subjectId:postId,detail:{slotId:id,policyRevision:slot.policy_revision,accountRevision:slot.account_revision,approvalKind:'standing_policy'}});
 });
}
export async function readLinkedinRecurringPosting(ctx:RepositoryContext,runtime?:LinkedinRecurringComposition|null):Promise<LinkedinRecurringView>{
 if(ctx.scope.actor.kind!=='user')return {holds:['owner_unavailable'],items:[]};
 const owner=ctx.scope.actor.userId;await lockLinkedinRecurringOwner(ctx,owner);
 const rows=(await ctx.db.query<LinkedinRecurringSlot&{delivery_state:string|null;receipt_id:string|null;submission_id:string|null;approval_kind:'standing_policy'|null;draft_state:string|null;spend:string}>(`SELECT s.*,d.state AS delivery_state,d.receipt_id,d.submission_id,a.approval_kind,r.state AS draft_state,COALESCE((SELECT sum(CASE WHEN v.state IN ('reserved','calling') THEN v.cents ELSE v.settled_cents END) FROM provider_reservations v WHERE v.workspace_id=s.workspace_id AND v.subject_kind='social_draft' AND v.subject_id=s.draft_request_id AND v.state<>'released'),0)::text AS spend FROM linkedin_recurring_slots s LEFT JOIN social_draft_requests r ON r.workspace_id=s.workspace_id AND r.id=s.draft_request_id LEFT JOIN social_deliveries d ON d.workspace_id=s.workspace_id AND d.post_id=s.post_id AND d.revision=1 LEFT JOIN social_post_approvals a ON a.workspace_id=d.workspace_id AND a.id=d.approval_id WHERE s.workspace_id=$1 AND s.owner_user_id=$2 ORDER BY s.target_at DESC LIMIT 25`,[ctx.scope.workspaceId,owner])).rows;
 const items:LinkedinRecurringView['items']=[];
 for(const s of rows){
  const scope=await linkedinRecurringScopeReason(ctx,s,runtime);
  let state:LinkedinRecurringView['items'][number]['state']=s.state==='review'?'review':s.state==='skipped'?'skipped':s.state==='queued'?'queued':'draft';
  let reason=s.reason;
  if(s.delivery_state==='scheduled'||s.delivery_state==='published')state='receipt';
  else if(s.submission_id||s.draft_state==='calling')state='unknown_paused';
  else if(scope==='policy_revoked'||scope==='policy_disabled')state='revoked';
  else if(scope&&s.state!=='skipped'&&s.state!=='review'){state='review';reason=scope;}
  items.push({id:s.id,targetAt:s.target_at.toISOString(),accountId:s.account_id,accountRevision:s.account_revision,policyRevision:s.policy_revision,state,reason,approvalKind:s.approval_kind,postId:s.post_id,draftRequestId:s.draft_request_id,receiptId:s.receipt_id,submissionId:s.submission_id,spendCents:Number(s.spend)});
 }
 return linkedinRecurringViewSchema.parse({holds:runtime?[]:['runtime_not_configured_publication_not_enabled'],items});
}
