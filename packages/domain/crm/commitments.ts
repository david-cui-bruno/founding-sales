import {createHash} from 'node:crypto';
import type {CrmCommitmentRead,CrmCommitmentReview,CrmCommitmentComplete,TodayPromiseTarget} from '@fss/contracts';
import {crmEvidenceClaimTargetSchema,crmCommitmentDueSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {recordCrmAuditEvent} from './audit.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockConflictSources,readCrmEvidence,targetAnchor} from './evidenceDecisions.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
import {readProcessingContext,processingContextHash} from './processingContext.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import type {CrmMailEvidencePort} from './mailEvidence.ts';
interface Review extends Record<string,unknown>{id:string;owner_user_id:string;family_key:string;activation_key:string|null;initial_context_snapshot:unknown;anchor_id:string|null;target:unknown;context_snapshot:unknown;original_access_closure:unknown;classification:CrmCommitmentReview['classification']|null;actor:CrmCommitmentReview['actor']|null;action_label:string|null;due:unknown;revision:number;projected_revision:number;today_eligibility:'current'|'historical'|'unknown'|null;projection_version:number;state:'pending'|'applied'|'suggestion'|'review_required'|'redacted'}
async function supported(context:RepositoryContext,target:ReturnType<typeof crmEvidenceClaimTargetSchema.parse>,mail:CrmMailEvidencePort,durableAnchorId?:string|null){
 const page=await readCrmEvidence(context,{source:target.source,limit:50},mail);
 if(page===null)return null;
 const claim=[...page.claims,...page.reviewedHistory].find(value=>value.claimId===target.claimId);
 if(claim!==undefined){
  if(claim.kind!=='commitment'||claim.claimHash!==target.claimHash||claim.contextHash!==target.contextHash||claim.decisionRevision!==target.expectedDecisionRevision||claim.reviewRequired||claim.effectiveState==='dismissed'||claim.effectiveState==='corrected')return null;
  return {claim:{anchorId:claim.anchorId,quote:claim.quote},source:page.source};
 }
 // An existing structured attestation binds its original physical claim, not a model's newest wording.
 if(durableAnchorId===undefined||durableAnchorId===null)return null;
 const currentContext=await readProcessingContext(context,target.source,mail);
 if(currentContext===null||processingContextHash(currentContext)!==target.contextHash)return null;
 const original=(await context.db.query<{id:string;quote:string;locator:string}>(`SELECT a.id,c.quote,c.locator FROM crm_claim_review_anchors a JOIN crm_extraction_claims c ON c.workspace_id=a.workspace_id AND c.id=a.original_claim_id JOIN crm_extraction_generations g ON g.workspace_id=c.workspace_id AND g.id=c.generation_id WHERE a.workspace_id=$1 AND a.id=$2 AND a.availability='available' AND a.original_claim_id=$3 AND a.original_claim_hash=$4 AND a.original_claim_revision=$5 AND a.current_decision_revision=$6 AND a.context_hash=$7 AND g.context_hash=$7 AND g.source_kind=$8 AND g.source_id=$9 AND g.source_revision=$10 AND g.source_hash=$11 AND g.state='complete' AND c.kind='commitment' AND c.claim_hash=$4 AND NOT EXISTS(SELECT 1 FROM crm_claim_review_anchors other WHERE other.workspace_id=a.workspace_id AND other.review_family_hash=a.review_family_hash AND other.id<>a.id AND other.current_decision_revision>0)`,[context.scope.workspaceId,durableAnchorId,target.claimId,target.claimHash,target.claimRevision,target.expectedDecisionRevision,target.contextHash,target.source.kind,target.source.sourceId,target.source.revision,target.source.contentHash])).rows[0];
 if(original===undefined)return null;
 const canonical=await resolveCrmSource(context,{...target.source,locator:original.locator},mail);
 if(canonical?.passage?.text!==original.quote)return null;
 return {claim:{anchorId:original.id,quote:original.quote},source:page.source};
}
function todayEligibility(input:CrmCommitmentReview,observedAt:string):'current'|'historical'|'unknown'{
 const due=input.due;if(due===null||input.classification!=='internal_promise'||input.actor==='unknown')return 'unknown';
 if(due.kind==='instant')return Date.parse(due.at)<Date.parse(observedAt)?'historical':'current';
 const parts=new Intl.DateTimeFormat('en',{timeZone:due.zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(observedAt));
 const calendarDate=['year','month','day'].map(kind=>parts.find(part=>part.type===kind)!.value).join('-');
 return due.date<calendarDate?'historical':'current';
}
async function conflictFree(context:RepositoryContext,anchorId:string){
 return !(await context.db.query(`SELECT 1 FROM crm_claim_conflict_members m JOIN crm_claim_conflicts c ON c.workspace_id=m.workspace_id AND c.id=m.conflict_id JOIN crm_claim_conflict_revisions r ON r.workspace_id=c.workspace_id AND r.conflict_id=c.id AND r.revision=c.current_revision WHERE m.workspace_id=$1 AND m.anchor_id=$2 AND m.revision=c.current_revision AND r.state='open' LIMIT 1`,[context.scope.workspaceId,anchorId])).rows.length;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Task extends Record<string,unknown>{id:string;owner_user_id:string;task_key:string;review_id:string|null;activation_receipt:ActivationReceipt|null;status:'open'|'done'|'cancelled';version:number;completed_at:Date|null;review_required:boolean}
interface ActivationReceipt {reviewId:string;reviewRevision:number;activationKey:string;sourceKind:string;sourceId:string;sourceRevision:number;sourceHash:string;anchorId:string;decisionRevision:number;contextHash:string;initialContextSnapshot:unknown;contextSnapshot:unknown;originalAccessClosure:unknown;actionHash:string;dueHash:string;activatedAt:string}
function actionIdentity(input:Pick<CrmCommitmentReview,'classification'|'actor'|'actionLabel'|'due'>){
 const due=input.due;
 const actionHash=hash([input.classification,input.actor,input.actionLabel.trim().replace(/\s+/gu,' ')]);
 const dueHash=hash(due===null?null:due.kind==='instant'?['instant',new Date(due.at).toISOString()]:['date',due.date,due.zone]);
 return {actionHash,dueHash};
}
function reviewContexts(rows:Review[],tasks:Task[]){return [...rows.flatMap(row=>[row.initial_context_snapshot,row.context_snapshot]),...tasks.flatMap(task=>task.activation_receipt===null?[]:[task.activation_receipt.initialContextSnapshot,task.activation_receipt.contextSnapshot])];}
function reviewClosures(rows:Review[],tasks:Task[]){return [...rows.map(row=>row.original_access_closure),...tasks.flatMap(task=>task.activation_receipt===null?[]:[task.activation_receipt.originalAccessClosure])];}
async function taskSnapshot(context:RepositoryContext,key:string){return (await context.db.query<Task>('SELECT * FROM crm_internal_tasks WHERE workspace_id=$1 AND task_key=$2',[context.scope.workspaceId,key])).rows[0];}
export async function readCrmCommitmentReviewStatus(context:RepositoryContext,input:ReturnType<typeof crmEvidenceClaimTargetSchema.parse>,mail:CrmMailEvidencePort=createNativeCrmMailEvidence()){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 const claim=(await context.db.query<{kind:string;locator:string}>('SELECT kind,locator FROM crm_extraction_claims WHERE workspace_id=$1 AND id=$2 AND claim_hash=$3',[context.scope.workspaceId,input.claimId,input.claimHash])).rows[0];
 if(claim===undefined||claim.kind!=='commitment')return null;
 const familyKey=hash(['crm-commitment-family-v1',actor.userId,hash(['crm-review-family-v1',input.source.kind,input.source.sourceId,claim.kind,claim.locator])]);
 const before=(await context.db.query<Review>("SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND family_key=$2 AND state<>'redacted'",[context.scope.workspaceId,familyKey])).rows[0];
 const taskBefore=before?.activation_key===undefined||before.activation_key===null?undefined:await taskSnapshot(context,before.activation_key);
 const rows=before===undefined?[]:[before],tasks=taskBefore===undefined?[]:[taskBefore];
 if(!await lockConflictSources(context,[input.source],reviewContexts(rows,tasks),reviewClosures(rows,tasks)))return null;
 const support=await supported(context,input,mail,before?.anchor_id);if(support===null||support.claim.anchorId!==null&&!await conflictFree(context,support.claim.anchorId))return null;
 const current=(await context.db.query<Review>("SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND family_key=$2 AND state<>'redacted' FOR SHARE",[context.scope.workspaceId,familyKey])).rows[0];
 const taskCurrent=current?.activation_key===undefined||current.activation_key===null?undefined:await taskSnapshot(context,current.activation_key);
 if(JSON.stringify(current)!==JSON.stringify(before)||JSON.stringify(taskCurrent)!==JSON.stringify(taskBefore)||!await activeIdentityActor(context))return null;
 return {current:current===undefined?null:{commitmentId:current.id,revision:current.revision,state:current.state}};
}
export async function reviewCrmCommitment(context:RepositoryContext,input:CrmCommitmentReview,mail:CrmMailEvidencePort=createNativeCrmMailEvidence()){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return {ok:false as const,reason:'source_unavailable'};
 // Metadata is used only to collect original authority before any source locks; current public proof is still mandatory below.
 const metadata=(await context.db.query<{locator:string;kind:string}>('SELECT locator,kind FROM crm_extraction_claims WHERE workspace_id=$1 AND id=$2 AND claim_hash=$3',[context.scope.workspaceId,input.claimId,input.claimHash])).rows[0];
 if(metadata===undefined||metadata.kind!=='commitment')return {ok:false as const,reason:'claim_changed'};
 const familyHash=hash(['crm-review-family-v1',input.source.kind,input.source.sourceId,metadata.kind,metadata.locator]);
 const familyKey=hash(['crm-commitment-family-v1',actor.userId,familyHash]);
 const identity=actionIdentity(input);const activationKey=hash(['crm-task-activation-v1',actor.userId,familyKey,identity.actionHash,identity.dueHash]);
 const before=(await context.db.query<Review>("SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND family_key=$2 AND state<>'redacted'",[context.scope.workspaceId,familyKey])).rows[0];
 const taskBefore=await taskSnapshot(context,activationKey);
 const oldRows=before===undefined?[]:[before],oldTasks=taskBefore===undefined?[]:[taskBefore];
 if(!await lockConflictSources(context,[input.source],reviewContexts(oldRows,oldTasks),reviewClosures(oldRows,oldTasks)))return {ok:false as const,reason:'source_unavailable'};
 const support=await supported(context,input,mail,before?.anchor_id);if(support===null)return {ok:false as const,reason:'claim_changed'};
 const anchor=await targetAnchor(context,input,mail);if(anchor===null||!await conflictFree(context,anchor.id))return {ok:false as const,reason:'claim_changed'};
 const provenance=(await context.db.query<{context_snapshot:unknown;original_access_closure:unknown;review_family_hash:string}>('SELECT context_snapshot,original_access_closure,review_family_hash FROM crm_claim_review_anchors WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,anchor.id])).rows[0]!;
 if(provenance.review_family_hash!==familyHash)return {ok:false as const,reason:'claim_changed'};
 if(input.sourceZoneReceipt!==undefined&&(input.sourceZoneReceipt.sourceRevision!==input.source.revision||input.sourceZoneReceipt.sourceHash!==input.source.contentHash||support.source.occurredAt===null||Date.parse(input.sourceZoneReceipt.eventAt)!==Date.parse(support.source.occurredAt)))return {ok:false as const,reason:'source_date_changed'};
 const old=(await context.db.query<Review>("SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND family_key=$2 AND state<>'redacted' FOR UPDATE",[context.scope.workspaceId,familyKey])).rows[0];
 const currentTask=await taskSnapshot(context,activationKey);
 if(JSON.stringify(old)!==JSON.stringify(before)||JSON.stringify(currentTask)!==JSON.stringify(taskBefore)||(old?.revision??0)!==input.expectedCommitmentRevision)return {ok:false as const,reason:'commitment_changed'};
 const target=crmEvidenceClaimTargetSchema.parse({source:input.source,claimId:input.claimId,claimRevision:input.claimRevision,claimHash:input.claimHash,contextHash:input.contextHash,expectedDecisionRevision:input.expectedDecisionRevision});
 const row=(await context.db.query<{id:string;revision:number}>(`INSERT INTO crm_commitment_reviews(workspace_id,owner_user_id,family_key,activation_key,anchor_id,target,initial_context_snapshot,context_snapshot,original_access_closure,classification,actor,action_label,due,source_zone_receipt,today_eligibility) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13::jsonb,$14) ON CONFLICT(workspace_id,family_key) WHERE state<>'redacted' DO UPDATE SET activation_key=EXCLUDED.activation_key,anchor_id=EXCLUDED.anchor_id,target=EXCLUDED.target,context_snapshot=EXCLUDED.context_snapshot,classification=EXCLUDED.classification,actor=EXCLUDED.actor,action_label=EXCLUDED.action_label,due=EXCLUDED.due,source_zone_receipt=EXCLUDED.source_zone_receipt,today_eligibility=EXCLUDED.today_eligibility,revision=crm_commitment_reviews.revision+1,state='pending',reviewed_at=clock_timestamp() RETURNING id,revision`,[context.scope.workspaceId,actor.userId,familyKey,activationKey,anchor.id,JSON.stringify(target),JSON.stringify(provenance.context_snapshot),JSON.stringify(provenance.original_access_closure),input.classification,input.actor,input.actionLabel,JSON.stringify(input.due),input.sourceZoneReceipt===undefined?null:JSON.stringify({...input.sourceZoneReceipt,basis:'explicit_human_review',eventAt:support.source.occurredAt}),todayEligibility(input,support.source.observedAt)])).rows[0]!;
 await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'crm.commitments_project',idempotencyKey:`commitment:${row.id}:${row.revision}`,payload:{commitmentId:row.id,revision:row.revision},maxAttempts:3});
 return {ok:true as const,value:{commitmentId:row.id,revision:row.revision,status:'queued' as const}};
}
export async function projectCrmCommitment(context:RepositoryContext,input:{commitmentId:string;revision:number},fence:()=>Promise<boolean>,jobReceipt:{jobId:string;fencingToken:string},mail:CrmMailEvidencePort=createNativeCrmMailEvidence()){
 if(!await fence())return;
 const before=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.commitmentId])).rows[0];
 if(before===undefined||before.state==='redacted'||before.revision!==input.revision||before.projected_revision>=input.revision)return;
 const taskBefore=before.activation_key===null?undefined:await taskSnapshot(context,before.activation_key);
 const target=crmEvidenceClaimTargetSchema.safeParse(before.target);if(!target.success||!await lockConflictSources(context,[target.data.source],reviewContexts([before],taskBefore===undefined?[]:[taskBefore]),reviewClosures([before],taskBefore===undefined?[]:[taskBefore])))return;
 const support=await supported(context,target.data,mail,before.anchor_id);if(support===null)return;
 const anchor=await targetAnchor(context,target.data,mail);if(anchor===null||anchor.id!==before.anchor_id||!await conflictFree(context,anchor.id))return;
 const current=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.commitmentId])).rows[0];
 if(current===undefined||current.revision!==before.revision||current.projection_version!==before.projection_version||JSON.stringify(current.target)!==JSON.stringify(before.target)||!await fence())return;
 const dated=crmCommitmentDueSchema.parse(current.due);
 const actionable=current.classification==='internal_promise'&&current.actor!=='unknown'&&dated!==null;
 const observed=(await context.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
 let task:Task|undefined;
 if(actionable){
  task=(await context.db.query<Task>('SELECT * FROM crm_internal_tasks WHERE workspace_id=$1 AND task_key=$2 FOR UPDATE',[context.scope.workspaceId,current.activation_key])).rows[0];
  if(JSON.stringify(task)!==JSON.stringify(taskBefore))return;
  const identity=actionIdentity({classification:current.classification!,actor:current.actor!,actionLabel:current.action_label!,due:dated});
  const activation:ActivationReceipt={reviewId:current.id,reviewRevision:current.revision,activationKey:current.activation_key!,sourceKind:target.data.source.kind,sourceId:target.data.source.sourceId,sourceRevision:target.data.source.revision,sourceHash:target.data.source.contentHash!,anchorId:anchor.id,decisionRevision:target.data.expectedDecisionRevision,contextHash:target.data.contextHash,initialContextSnapshot:current.initial_context_snapshot,contextSnapshot:current.context_snapshot,originalAccessClosure:current.original_access_closure,...identity,activatedAt:observed};
  if(task===undefined)task=(await context.db.query<Task>('INSERT INTO crm_internal_tasks(workspace_id,owner_user_id,task_key,review_id,activation_receipt) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *',[context.scope.workspaceId,current.owner_user_id,current.activation_key,current.id,JSON.stringify(activation)])).rows[0];
  else if(task.status==='open'&&(task.review_id!==current.id||task.review_required||task.activation_receipt===null))task=(await context.db.query<Task>('UPDATE crm_internal_tasks SET review_id=$3,activation_receipt=coalesce(activation_receipt,$4::jsonb),review_required=false,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$5 RETURNING *',[context.scope.workspaceId,task.id,current.id,JSON.stringify(activation),task.version])).rows[0];
 }
 const outcome=!actionable?'suggestion':task?.status==='done'?'already_completed':'applied';
 const receipt={reviewRevision:current.revision,sourceKind:target.data.source.kind,sourceId:target.data.source.sourceId,sourceRevision:target.data.source.revision,sourceHash:target.data.source.contentHash,anchorId:anchor.id,decisionRevision:target.data.expectedDecisionRevision,contextHash:target.data.contextHash,activationKey:current.activation_key,taskId:task?.id??null,outcome,observedAt:observed,...jobReceipt};
 await context.db.query("UPDATE crm_commitment_reviews SET state=$4,projected_revision=$3,projection_version=projection_version+1,projection_receipt=$6::jsonb WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND projection_version=$5 AND state<>'redacted'",[context.scope.workspaceId,current.id,current.revision,actionable?'applied':'suggestion',current.projection_version,JSON.stringify(receipt)]);
}
export async function readCrmCommitments(context:RepositoryContext,input:CrmCommitmentRead,mail:CrmMailEvidencePort=createNativeCrmMailEvidence()){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 const scope=input.scope;
 if(scope.kind==='history'){
  const tasks=(await context.db.query<{id:string;status:'done'|'cancelled';version:number;completed_at:Date|null}>("SELECT id,status,version,completed_at FROM crm_internal_tasks WHERE workspace_id=$1 AND owner_user_id=$2 AND status IN ('done','cancelled') AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4 FOR SHARE",[context.scope.workspaceId,actor.userId,input.afterId??null,input.limit+1])).rows;
  if(!await activeIdentityActor(context))return null;
  return {items:tasks.slice(0,input.limit).map(task=>({taskId:task.id,status:task.status,version:task.version,completedAt:task.completed_at?.toISOString()??null})),nextAfterId:tasks.length>input.limit?tasks[input.limit-1]!.id:null};
 }
 const rows=(await context.db.query<Review>(`SELECT r.* FROM crm_commitment_reviews r WHERE workspace_id=$1 AND owner_user_id=$2 AND ($3::uuid IS NULL OR id>$3) AND state<>'redacted' AND CASE $4::text
 WHEN 'person' THEN context_snapshot->>'personId'=$5
 WHEN 'firm' THEN context_snapshot->'firmIds' ? $5
 WHEN 'source' THEN target->'source'->>'sourceId'=$5 AND target->'source'->>'kind'=$6
 ELSE state='applied' AND today_eligibility='current' AND EXISTS(SELECT 1 FROM crm_internal_tasks t WHERE t.workspace_id=r.workspace_id AND t.task_key=r.activation_key AND t.status='open') END
 ORDER BY id LIMIT $7`,[context.scope.workspaceId,actor.userId,input.afterId??null,scope.kind,scope.kind==='person'?scope.personId:scope.kind==='firm'?scope.firmId:scope.kind==='source'?scope.sourceId:null,scope.kind==='source'?scope.sourceKind:null,input.limit+1])).rows;
 const candidates=rows.filter(row=>{if(row.state==='redacted')return false;const parsed=crmEvidenceClaimTargetSchema.safeParse(row.target);if(!parsed.success)return false;const contextView=row.context_snapshot as {personId?:string;firmIds?:string[]};return scope.kind==='source'?parsed.data.source.sourceId===scope.sourceId&&parsed.data.source.kind===scope.sourceKind:scope.kind==='person'?contextView.personId===scope.personId:scope.kind==='firm'?contextView.firmIds?.includes(scope.firmId)===true:true;});
 const live=candidates.filter(row=>row.state!=='redacted');const targets=live.map(row=>crmEvidenceClaimTargetSchema.parse(row.target));
 const taskRows=(await context.db.query<Task>('SELECT * FROM crm_internal_tasks WHERE workspace_id=$1 AND task_key=ANY($2::text[]) ORDER BY id',[context.scope.workspaceId,live.map(row=>row.activation_key)])).rows;
 if(!await lockConflictSources(context,targets.map(target=>target.source),reviewContexts(live,taskRows),reviewClosures(live,taskRows)))return null;
 const items=[];
 for(const row of candidates.slice(0,input.limit)){
  const locked=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,row.id])).rows[0];
  if(locked===undefined||JSON.stringify(locked)!==JSON.stringify(row))return null;
  const target=crmEvidenceClaimTargetSchema.safeParse(row.target);
  if(row.state==='redacted'||!target.success)continue;
  const baseSupport=await supported(context,target.data,mail,row.anchor_id);
  const support=baseSupport!==null&&await conflictFree(context,row.anchor_id!)?baseSupport:null;
  if(support===null&&await readCrmEvidence(context,{source:target.data.source,limit:50},mail)===null)return null;
  const tasks=(await context.db.query<Task>('SELECT * FROM crm_internal_tasks WHERE workspace_id=$1 AND task_key=$2 FOR SHARE',[context.scope.workspaceId,row.activation_key])).rows;
  if(JSON.stringify(tasks)!==JSON.stringify(taskRows.filter(task=>task.task_key===row.activation_key)))return null;
  if(scope.kind==='today'&&(support===null||row.state!=='applied'||tasks[0]?.status!=='open'||row.due===null||row.today_eligibility!=='current'))continue;
  items.push({commitmentId:row.id,revision:row.revision,state:support===null?'review_required' as const:row.state,todayEligibility:support===null?null:row.today_eligibility,actor:support===null?null:row.actor,actionLabel:support===null?null:row.action_label,due:support===null?null:crmCommitmentDueSchema.parse(row.due),quote:support?.claim.quote??null,source:support?.source??null,task:tasks[0]===undefined?null:{taskId:tasks[0].id,status:tasks[0].status,version:tasks[0].version,completedAt:tasks[0].completed_at?.toISOString()??null}});
 }
 if(!await activeIdentityActor(context))return null;
 return {items,nextAfterId:candidates.length>input.limit?candidates[input.limit-1]!.id:null};
}

export async function completeCrmCommitment(context:RepositoryContext,input:CrmCommitmentComplete,mail:CrmMailEvidencePort=createNativeCrmMailEvidence()){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return {ok:false as const,reason:'source_unavailable'};
 const task=(await context.db.query<Task>('SELECT * FROM crm_internal_tasks WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3',[context.scope.workspaceId,input.taskId,actor.userId])).rows[0];
 if(task===undefined||task.review_id===null)return {ok:false as const,reason:'work_unavailable'};
 const review=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,task.review_id])).rows[0];
 const target=crmEvidenceClaimTargetSchema.safeParse(review?.target);
 if(review===undefined||review.state!=='applied'||review.activation_key!==task.task_key||task.activation_receipt===null||!target.success||!await lockConflictSources(context,[target.data.source],reviewContexts([review],[task]),reviewClosures([review],[task])))return {ok:false as const,reason:'work_requires_review'};
 const supportedView=await supported(context,target.data,mail,review.anchor_id);const anchor=await targetAnchor(context,target.data,mail);
 if(supportedView===null||anchor===null||!await conflictFree(context,anchor.id))return {ok:false as const,reason:'work_requires_review'};
 const currentReview=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,review.id])).rows[0];
 if(JSON.stringify(currentReview)!==JSON.stringify(review))return {ok:false as const,reason:'commitment_changed'};
 const current=(await context.db.query<{version:number;status:string;completed_at:Date|null}>('SELECT version,status,completed_at FROM crm_internal_tasks WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE',[context.scope.workspaceId,input.taskId,actor.userId])).rows[0];
 if(current?.status==='done'&&current.completed_at!==null)return {ok:true as const,value:{taskId:input.taskId,version:current.version,completedAt:current.completed_at.toISOString()}};
 if(current?.status!=='open'||current.version!==input.expectedVersion||!await activeIdentityActor(context))return {ok:false as const,reason:'work_changed'};
 const changed=(await context.db.query<{version:number;completed_at:Date}>("UPDATE crm_internal_tasks SET status='done',version=version+1,completed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND version=$3 RETURNING version,completed_at",[context.scope.workspaceId,input.taskId,input.expectedVersion])).rows[0]!;
 await recordCrmAuditEvent(context,{action:'crm.internal_task_completed',subjectKind:'crm_internal_task',subjectId:input.taskId,detail:{version:changed.version}});
 return {ok:true as const,value:{taskId:input.taskId,version:changed.version,completedAt:changed.completed_at.toISOString()}};
}

/** Private action proof is resolved under the same source/context locks as current work. */
export async function readCrmCommitmentActionProofs(context:RepositoryContext){
 const page=await readCrmCommitments(context,{scope:{kind:'today'},limit:50});
 if(page===null||page.nextAfterId!==null||page.items.some(item=>!('commitmentId' in item)))return null;
 const items=page.items.filter(item=>'commitmentId' in item);
 const result=[];
 for(const item of items){
  if(item.task===null||item.task.status!=='open'||item.due===null||item.actionLabel===null)continue;
  const row=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,item.commitmentId])).rows[0];
  if(row===undefined||row.revision!==item.revision||row.state!=='applied')return null;
  const target=crmEvidenceClaimTargetSchema.parse(row.target);
  const proof:TodayPromiseTarget={kind:'internal_task',taskId:item.task.taskId,expectedVersion:item.task.version,review:{commitmentId:row.id,revision:row.revision,projectionVersion:row.projection_version},support:{sourceKind:target.source.kind,sourceId:target.source.sourceId,sourceRevision:target.source.revision,sourceHash:target.source.contentHash!,contextHash:target.contextHash,decisionRevision:target.expectedDecisionRevision}};
  result.push({target:proof,subject:item.actionLabel,due:item.due});
 }
 return result;
}

/** Cached acknowledgements never stand in for current source or human review authority. */
export async function validateCrmCommitmentReviewReceipt(context:RepositoryContext,input:CrmCommitmentReview,receipt:{commitmentId:string;revision:number},mail:CrmMailEvidencePort=createNativeCrmMailEvidence()){
 const status=await readCrmCommitmentReviewStatus(context,input,mail);if(status===null)return 'unavailable' as const;
 if(status.current?.commitmentId!==receipt.commitmentId||status.current.revision!==receipt.revision)return 'changed' as const;
 const current=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,receipt.commitmentId])).rows[0];
 const target=crmEvidenceClaimTargetSchema.parse({source:input.source,claimId:input.claimId,claimRevision:input.claimRevision,claimHash:input.claimHash,contextHash:input.contextHash,expectedDecisionRevision:input.expectedDecisionRevision});
 const stored=crmEvidenceClaimTargetSchema.safeParse(current?.target);
 if(current===undefined||current.revision!==receipt.revision||!stored.success||JSON.stringify(stored.data)!==JSON.stringify(target))return 'changed' as const;
 return await activeIdentityActor(context)?'current' as const:'unavailable' as const;
}
