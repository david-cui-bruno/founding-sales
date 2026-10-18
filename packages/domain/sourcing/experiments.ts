import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import {experimentRollbackDispositionSchema,experimentsViewSchema,experimentSaveSchema,experimentActivateSchema,experimentStopSchema,experimentEraseSchema,type ExperimentContent} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readSourcingLearning} from './learningReport.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {ensureTargetingPolicy,saveTargetingProposal,applyTargetingProposal} from './targetingProposals.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
const admin=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin';
type Report=Awaited<ReturnType<typeof snapshot>>;
async function snapshot(ctx:RepositoryContext,input:ExperimentContent['interval']){
 const r=await readSourcingLearning(ctx,input);
 return {from:r.from,to:r.to,asOf:r.asOf,cohorts:r.cohorts,maturity:r.maturity,coverage:r.coverage,search:r.search,discovery:r.automation?.discovery??null,cutoffSemantics:'current_accepted_facts_through_cutoff',rawProviderResults:null,duplicates:null};
}
type Revision = {revision:number;content:ExperimentContent;report:Report;created_at:Date}
type Activation = {activation_id:string;revision:number;result:Record<string,string>;started_at:Date;stopped_at:Date|null;stop_reason:string|null}
/** Caller transaction. Proposals copy aggregate counts, never private source bodies/firm identities. */
export async function saveExperiment(ctx:RepositoryContext,input:z.infer<typeof experimentSaveSchema>):Promise<Result<{id:string;revision:number}>>{
 if(!admin(ctx))return {ok:false,reason:'admin_only'};
 const parsed=experimentSaveSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const w=ctx.scope.workspaceId,id=input.id??randomUUID();
 if(input.id===undefined&&input.expectedRevision!==0)return {ok:false,reason:'proposal_changed'};
 if(input.id===undefined)await ctx.db.query("INSERT INTO sourcing_experiments(workspace_id,id,status) VALUES($1,$2,$3)",[w,id,input.status]);
 const head=(await ctx.db.query<{revision:number;status:string}>('SELECT revision,status FROM sourcing_experiments WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,id])).rows[0];
 if(!head)return {ok:false,reason:'not_found'};if(head.status==='erased')return {ok:false,reason:'proposal_erased'};if(head.revision!==input.expectedRevision)return {ok:false,reason:'proposal_changed'};
 if((await ctx.db.query('SELECT 1 FROM sourcing_experiment_activations WHERE workspace_id=$1 AND id=$2 AND stopped_at IS NULL',[w,id])).rows.length)return {ok:false,reason:'experiment_active'};
 const report=await snapshot(ctx,input.content.interval),revision=head.revision+1;
 const actor=ctx.scope.actor;if(actor.kind!=='user')return {ok:false,reason:'admin_only'};
 await ctx.db.query('INSERT INTO sourcing_experiment_revisions(workspace_id,id,revision,content,report,created_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)',[w,id,revision,JSON.stringify(parsed.data.content),JSON.stringify(report),actor.userId]);
 await ctx.db.query('UPDATE sourcing_experiments SET revision=$3,status=$4 WHERE workspace_id=$1 AND id=$2',[w,id,revision,input.status]);
 await recordCrmAuditEvent(ctx,{action:'sourcing.experiment_reviewed',subjectKind:'sourcing_experiment',subjectId:id,detail:{revision,status:input.status}});
 return {ok:true,value:{id,revision}};
}
async function activationOutcomes(ctx:RepositoryContext,a:Activation){
 if(a.result['kind']==='email_wording'){
  const r=(await ctx.db.query<{attempts:number;sent:number}>(`SELECT count(*) FILTER(WHERE m.dispatch_started_at IS NOT NULL)::int AS attempts,count(*) FILTER(WHERE m.state='sent')::int AS sent FROM sequence_enrollments n JOIN outbound_messages m ON m.workspace_id=n.workspace_id AND m.enrollment_id=n.id WHERE n.workspace_id=$1 AND n.sequence_version_id=$2 AND n.created_at>=$3 AND ($4::timestamptz IS NULL OR n.created_at<$4)`,[ctx.scope.workspaceId,a.result['sequenceVersionId'],a.started_at,a.stopped_at])).rows[0]!;
  return {attempts:r.attempts,sent:r.sent,retainedUniqueUrls:null,rawProviderResults:null,duplicates:null,supportedProspects:null,conversionDenominator:null,semantics:'exact_sequence_new_enrollments_only'};
 }
 const row=(await ctx.db.query<{attempts:number;retained:number}>(`SELECT count(DISTINCT d.id)::int AS attempts,count(DISTINCT h.source_url)::int AS retained FROM sourcing_discovery_attempts d LEFT JOIN sourcing_discovery_hits h ON h.workspace_id=d.workspace_id AND h.attempt_id=d.id WHERE d.workspace_id=$1 AND d.policy_version=$2 AND d.query_id=$3 AND d.created_at>=$4 AND ($5::timestamptz IS NULL OR d.created_at<$5)`,[ctx.scope.workspaceId,a.result['policyVersion'],a.result['queryId'],a.started_at,a.stopped_at])).rows[0]!;
 return {attempts:row.attempts,retainedUniqueUrls:row.retained,rawProviderResults:null,duplicates:null,supportedProspects:null,conversionDenominator:null,semantics:'exact_policy_query_attempts_only'};
}
/** Caller transaction; bounded heads are held in deterministic order through evidence reads. */
export async function readExperiments(ctx:RepositoryContext){
 if(!admin(ctx))return [];
 const w=ctx.scope.workspaceId,heads=(await ctx.db.query<{id:string;revision:number;status:'accepted'|'dismissed'|'erased'}>('SELECT id,revision,status FROM sourcing_experiments WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 31 FOR SHARE',[w])).rows;
 const output=[];
 for(const h of heads.slice(0,30)){
  const revisions=(await ctx.db.query<Revision>('SELECT revision,content,report,created_at FROM sourcing_experiment_revisions WHERE workspace_id=$1 AND id=$2 ORDER BY revision DESC LIMIT 21',[w,h.id])).rows;
  const activations=[];
  const activationRows=(await ctx.db.query<Activation>('SELECT activation_id,revision,result,started_at,stopped_at,stop_reason FROM sourcing_experiment_activations WHERE workspace_id=$1 AND id=$2 ORDER BY started_at DESC,activation_id DESC LIMIT 21',[w,h.id])).rows;
  for(const a of activationRows.slice(0,20)){
   activations.push({activationId:a.activation_id,revision:a.revision,result:a.result,startedAt:a.started_at.toISOString(),stoppedAt:a.stopped_at?.toISOString()??null,stopReason:a.stop_reason,outcomes:await activationOutcomes(ctx,a)});
  }
  output.push({...h,coverage:{proposalsTruncated:heads.length>30,versionsTruncated:revisions.length>20,activationsTruncated:activationRows.length>20},versions:revisions.slice(0,20).map(r=>({revision:r.revision,content:r.content,report:r.report,createdAt:r.created_at.toISOString()})),report:revisions.find(r=>r.revision===h.revision)?.report??null,activations});
 }
 return experimentsViewSchema.parse(output);
}
export async function activateExperiment(ctx:RepositoryContext,input:z.infer<typeof experimentActivateSchema>):Promise<Result<{activationId:string}>>{
 if(!admin(ctx))return {ok:false,reason:'admin_only'};
 if(!experimentActivateSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 await lockSendGateForStopFact(ctx);
 const policy=await ensureTargetingPolicy(ctx),w=ctx.scope.workspaceId;
 const h=(await ctx.db.query<{revision:number;status:string}>('SELECT revision,status FROM sourcing_experiments WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.id])).rows[0];
 if(!h)return {ok:false,reason:'not_found'};
 if(h.revision!==input.expectedRevision||h.status!=='accepted')return {ok:false,reason:'proposal_changed'};
 if((await ctx.db.query('SELECT 1 FROM sourcing_experiment_activations WHERE workspace_id=$1 AND stopped_at IS NULL',[w])).rows.length)return {ok:false,reason:'experiment_active'};
 const revision=(await ctx.db.query<Revision>('SELECT content FROM sourcing_experiment_revisions WHERE workspace_id=$1 AND id=$2 AND revision=$3',[w,input.id,h.revision])).rows[0]!;
 const change=revision.content.change;
 if(change.kind==='email_wording')return {ok:false,reason:'automatic_admission_removed'};
 if(!input.targetingDecision)return {ok:false,reason:'targeting_decision_required'};
 if(change.basePolicyVersion!==policy.version)return {ok:false,reason:'policy_changed'};
 const query=policy.queries.find(q=>q.id===change.queryId);if(!query)return {ok:false,reason:'query_unavailable'};
 const proposal=await saveTargetingProposal(ctx,{basePolicyVersion:policy.version,queryChanges:[{...query,query:change.query}],rankOrder:policy.rankOrder as ['help_request','operational_burden','investigation','fit_only'],evidenceIds:[],rationale:revision.content.rationale});
 if(!proposal.ok)return proposal;
 const applied=await applyTargetingProposal(ctx,{id:proposal.value.id,expectedRevision:proposal.value.revision});if(!applied.ok)return applied;
 const activationId=randomUUID(),result={kind:'discovery_query',basePolicyVersion:policy.version,policyVersion:applied.value.policyVersion,queryId:query.id};
 await ctx.db.query('INSERT INTO sourcing_experiment_activations(workspace_id,id,revision,activation_id,result) VALUES($1,$2,$3,$4,$5::jsonb)',[w,input.id,h.revision,activationId,JSON.stringify(result)]);
 await recordCrmAuditEvent(ctx,{action:'sourcing.experiment_activated',subjectKind:'sourcing_experiment',subjectId:input.id,detail:{activationId,revision:h.revision,...result}});
 return {ok:true,value:{activationId}};
}
export async function stopExperiment(ctx:RepositoryContext,input:z.infer<typeof experimentStopSchema>):Promise<Result<{stopped:boolean;rollbackDisposition:z.infer<typeof experimentRollbackDispositionSchema>}>>{
 if(!admin(ctx))return {ok:false,reason:'admin_only'};
 if(!experimentStopSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 await lockSendGateForStopFact(ctx);
 const policy=await ensureTargetingPolicy(ctx),w=ctx.scope.workspaceId;
 const a=(await ctx.db.query<Activation>('SELECT * FROM sourcing_experiment_activations WHERE workspace_id=$1 AND activation_id=$2 FOR UPDATE',[w,input.activationId])).rows[0];
 if(!a)return {ok:false,reason:'not_found'};
 if(a.stopped_at)return {ok:true,value:{stopped:true,rollbackDisposition:experimentRollbackDispositionSchema.parse(a.result['rollbackDisposition'])}};
 let disposition:z.infer<typeof experimentRollbackDispositionSchema>;
 if(a.result['kind']==='email_wording'){
  // Retained historical activation only. No retired admission settings are rewritten.
  disposition='separate_approval_required';
 }else if(a.result['policyVersion']===policy.version){
  await ctx.db.query('UPDATE sourcing_discovery_settings SET targeting_version=$2 WHERE workspace_id=$1',[w,a.result['basePolicyVersion']]);
  disposition='restored';
 }else disposition='superseded';
 await ctx.db.query("UPDATE sourcing_experiment_activations SET stopped_at=now(),stop_reason=$3,result=result||jsonb_build_object('rollbackDisposition',$4::text) WHERE workspace_id=$1 AND activation_id=$2",[w,input.activationId,input.reason,disposition]);
 await recordCrmAuditEvent(ctx,{action:'sourcing.experiment_stopped',subjectKind:'sourcing_experiment',subjectId:input.activationId,detail:{revision:a.revision,reasonCode:'explicit_stop',rollbackDisposition:disposition}});
 return {ok:true,value:{stopped:true,rollbackDisposition:disposition}};
}

/** Erasure removes retained user prose/aggregates; opaque activation identity remains attributable. */
export async function eraseExperiment(ctx:RepositoryContext,input:z.infer<typeof experimentEraseSchema>):Promise<Result<{erased:boolean}>>{
 if(!admin(ctx))return {ok:false,reason:'admin_only'};
 if(!experimentEraseSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 const w=ctx.scope.workspaceId;
 const h=(await ctx.db.query<{revision:number;status:string}>('SELECT revision,status FROM sourcing_experiments WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.id])).rows[0];
 if(!h)return {ok:false,reason:'not_found'};if(h.revision!==input.expectedRevision)return {ok:false,reason:'proposal_changed'};
 if((await ctx.db.query('SELECT 1 FROM sourcing_experiment_activations WHERE workspace_id=$1 AND id=$2 AND stopped_at IS NULL',[w,input.id])).rows.length)return {ok:false,reason:'experiment_active'};
 await ctx.db.query('DELETE FROM sourcing_experiment_revisions WHERE workspace_id=$1 AND id=$2',[w,input.id]);
 await ctx.db.query("UPDATE sourcing_experiment_activations SET stop_reason='evidence_erased' WHERE workspace_id=$1 AND id=$2 AND stopped_at IS NOT NULL",[w,input.id]);
 await ctx.db.query("UPDATE sourcing_experiments SET status='erased' WHERE workspace_id=$1 AND id=$2",[w,input.id]);
 await recordCrmAuditEvent(ctx,{action:'sourcing.experiment_erased',subjectKind:'sourcing_experiment',subjectId:input.id,detail:{revision:h.revision}});
 return {ok:true,value:{erased:true}};
}
