import {createHash} from 'node:crypto';
import type {CrmCommitmentRead,CrmCommitmentReview} from '@fss/contracts';
import {crmEvidenceClaimTargetSchema,crmCommitmentDueSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockConflictSources,readCrmEvidence,targetAnchor} from './evidenceDecisions.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
import type {CrmMailEvidencePort} from './mailEvidence.ts';
interface Review extends Record<string,unknown>{id:string;owner_user_id:string;task_key:string;anchor_id:string|null;target:unknown;context_snapshot:unknown;original_access_closure:unknown;classification:CrmCommitmentReview['classification']|null;actor:CrmCommitmentReview['actor']|null;action_label:string|null;due:unknown;revision:number;projected_revision:number;state:'pending'|'applied'|'suggestion'|'review_required'|'redacted'}
async function supported(context:RepositoryContext,target:ReturnType<typeof crmEvidenceClaimTargetSchema.parse>,mail:CrmMailEvidencePort){
 const page=await readCrmEvidence(context,{source:target.source,limit:50},mail);
 const claim=page===null?undefined:[...page.claims,...page.reviewedHistory].find(value=>value.claimId===target.claimId);
 if(claim===undefined||claim.kind!=='commitment'||claim.claimHash!==target.claimHash||claim.contextHash!==target.contextHash||claim.decisionRevision!==target.expectedDecisionRevision||claim.reviewRequired||claim.effectiveState==='dismissed'||claim.effectiveState==='corrected')return null;
 return {claim,source:page!.source};
}
async function conflictFree(context:RepositoryContext,anchorId:string){
 return !(await context.db.query(`SELECT 1 FROM crm_claim_conflict_members m JOIN crm_claim_conflicts c ON c.workspace_id=m.workspace_id AND c.id=m.conflict_id JOIN crm_claim_conflict_revisions r ON r.workspace_id=c.workspace_id AND r.conflict_id=c.id AND r.revision=c.current_revision WHERE m.workspace_id=$1 AND m.anchor_id=$2 AND m.revision=c.current_revision AND r.state='open' LIMIT 1`,[context.scope.workspaceId,anchorId])).rows.length;
}
export async function reviewCrmCommitment(context:RepositoryContext,input:CrmCommitmentReview,mail:CrmMailEvidencePort=createNativeCrmMailEvidence()){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context)||!await lockConflictSources(context,[input.source]))return {ok:false as const,reason:'source_unavailable'};
 const support=await supported(context,input,mail);if(support===null)return {ok:false as const,reason:'claim_changed'};
 const anchor=await targetAnchor(context,input,mail);if(anchor===null||!await conflictFree(context,anchor.id))return {ok:false as const,reason:'claim_changed'};
 if(input.sourceZoneReceipt!==undefined&&(input.sourceZoneReceipt.sourceRevision!==input.source.revision||input.sourceZoneReceipt.sourceHash!==input.source.contentHash||support.source.occurredAt===null||Date.parse(input.sourceZoneReceipt.eventAt)!==Date.parse(support.source.occurredAt)))return {ok:false as const,reason:'source_date_changed'};
 const key=createHash('sha256').update(anchor.id).digest('hex');
 const old=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND task_key=$2 FOR UPDATE',[context.scope.workspaceId,key])).rows[0];
 if((old?.revision??0)!==input.expectedCommitmentRevision||old?.state==='redacted')return {ok:false as const,reason:'commitment_changed'};
 const provenance=(await context.db.query<{context_snapshot:unknown;original_access_closure:unknown}>('SELECT context_snapshot,original_access_closure FROM crm_claim_review_anchors WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,anchor.id])).rows[0]!;
 const target=crmEvidenceClaimTargetSchema.parse({source:input.source,claimId:input.claimId,claimRevision:input.claimRevision,claimHash:input.claimHash,contextHash:input.contextHash,expectedDecisionRevision:input.expectedDecisionRevision});
 const row=(await context.db.query<{id:string;revision:number}>(`INSERT INTO crm_commitment_reviews(workspace_id,owner_user_id,task_key,anchor_id,target,context_snapshot,original_access_closure,classification,actor,action_label,due,source_zone_receipt) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb) ON CONFLICT(workspace_id,task_key) DO UPDATE SET target=EXCLUDED.target,classification=EXCLUDED.classification,actor=EXCLUDED.actor,action_label=EXCLUDED.action_label,due=EXCLUDED.due,source_zone_receipt=EXCLUDED.source_zone_receipt,revision=crm_commitment_reviews.revision+1,state='pending',reviewed_at=clock_timestamp() RETURNING id,revision`,[context.scope.workspaceId,actor.userId,key,anchor.id,JSON.stringify(target),JSON.stringify(provenance.context_snapshot),JSON.stringify(provenance.original_access_closure),input.classification,input.actor,input.actionLabel,JSON.stringify(input.due),input.sourceZoneReceipt===undefined?null:JSON.stringify({...input.sourceZoneReceipt,basis:'explicit_human_review',eventAt:support.source.occurredAt})])).rows[0]!;
 await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'crm.commitments_project',idempotencyKey:`commitment:${row.id}:${row.revision}`,payload:{commitmentId:row.id,revision:row.revision},maxAttempts:3});
 return {ok:true as const,value:{commitmentId:row.id,revision:row.revision,status:'queued' as const}};
}
export async function projectCrmCommitment(context:RepositoryContext,input:{commitmentId:string;revision:number},fence:()=>Promise<boolean>,mail:CrmMailEvidencePort=createNativeCrmMailEvidence()){
 if(!await fence())return;
 const before=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.commitmentId])).rows[0];
 if(before===undefined||before.state==='redacted'||before.revision!==input.revision||before.projected_revision>=input.revision)return;
 const target=crmEvidenceClaimTargetSchema.safeParse(before.target);if(!target.success||!await lockConflictSources(context,[target.data.source],[before.context_snapshot],[before.original_access_closure]))return;
 const support=await supported(context,target.data,mail);if(support===null)return;
 const anchor=await targetAnchor(context,target.data,mail);if(anchor===null||anchor.id!==before.anchor_id||!await conflictFree(context,anchor.id))return;
 const current=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.commitmentId])).rows[0];
 if(current===undefined||current.revision!==before.revision||JSON.stringify(current.target)!==JSON.stringify(before.target)||!await fence())return;
 const dated=crmCommitmentDueSchema.parse(current.due);
 const actionable=current.classification==='internal_promise'&&current.actor!=='unknown'&&dated!==null;
 if(actionable)await context.db.query(`INSERT INTO crm_internal_tasks(workspace_id,owner_user_id,task_key,review_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,task_key) DO NOTHING`,[context.scope.workspaceId,current.owner_user_id,current.task_key,current.id]);
 await context.db.query("UPDATE crm_commitment_reviews SET state=$4,projected_revision=$3 WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND state<>'redacted'",[context.scope.workspaceId,current.id,current.revision,actionable?'applied':'suggestion']);
}
export async function readCrmCommitments(context:RepositoryContext,input:CrmCommitmentRead,mail:CrmMailEvidencePort=createNativeCrmMailEvidence()){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 const scope=input.scope;
 const rows=(await context.db.query<Review>(`SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND owner_user_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 51`,[context.scope.workspaceId,actor.userId,input.afterId??null])).rows;
 const candidates=rows.filter(row=>{if(row.state==='redacted')return scope.kind==='today';const parsed=crmEvidenceClaimTargetSchema.safeParse(row.target);if(!parsed.success)return false;const contextView=row.context_snapshot as {personId?:string;firmIds?:string[]};return scope.kind==='source'?parsed.data.source.sourceId===scope.sourceId&&parsed.data.source.kind===scope.sourceKind:scope.kind==='person'?contextView.personId===scope.personId:scope.kind==='firm'?contextView.firmIds?.includes(scope.firmId)===true:true;});
 if(candidates.length>50)return null;
 const live=candidates.filter(row=>row.state!=='redacted');const targets=live.map(row=>crmEvidenceClaimTargetSchema.parse(row.target));
 if(!await lockConflictSources(context,targets.map(target=>target.source),live.map(row=>row.context_snapshot),live.map(row=>row.original_access_closure)))return null;
 const items=[];
 for(const row of candidates.slice(0,input.limit)){
  const locked=(await context.db.query<Review>('SELECT * FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,row.id])).rows[0];
  if(locked===undefined||JSON.stringify(locked)!==JSON.stringify(row))return null;
  const target=crmEvidenceClaimTargetSchema.safeParse(row.target);
  if(row.state==='redacted'||!target.success)continue;
  const support=await supported(context,target.data,mail);if(support===null)return null;
  const tasks=(await context.db.query<{id:string;status:'open'|'done'|'cancelled';version:number;completed_at:Date|null}>('SELECT id,status,version,completed_at FROM crm_internal_tasks WHERE workspace_id=$1 AND task_key=$2 FOR SHARE',[context.scope.workspaceId,row.task_key])).rows;
  items.push({commitmentId:row.id,revision:row.revision,state:row.state,actor:row.actor,actionLabel:row.action_label,due:crmCommitmentDueSchema.parse(row.due),quote:support.claim.quote,source:support.source,task:tasks[0]===undefined?null:{taskId:tasks[0].id,status:tasks[0].status,version:tasks[0].version,completedAt:tasks[0].completed_at?.toISOString()??null}});
 }
 if(!await activeIdentityActor(context))return null;
 return {items,nextAfterId:candidates.length>input.limit?candidates[input.limit-1]!.id:null};
}
