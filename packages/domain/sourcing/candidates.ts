import { visibleSourceCheck } from './sourceCheck.ts';
import { createHash } from 'node:crypto';
import {
  candidateInputSchema, candidateListInputSchema, candidateReviewInputSchema,
  candidateDeleteInputSchema, candidateSchema, type candidateListSchema,
  type CandidateInput, type SourcingCandidate,
} from '@fss/contracts';
import type { z } from 'zod';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideAdminOnly } from '../crm/authorization.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { databaseNow } from '../policy/clock.ts';
import {verifiedFirmOwner,verifiedWebsiteKey,IDENTITY_REVIEW_REASONS} from './verifiedFirmPolicy.ts';
import {discoveryQuotaRemaining} from './discoveryQuota.ts';
import {isCurrentPreparedCandidatePayload} from './discoveryIntake.ts';
import {lockLivePreparationCleanup} from '../calling/preparationLifecycle.ts';

type Result<T> = {ok:true;value:T} | {ok:false;reason:string};
interface Row { id:string;payload:CandidateInput;status:SourcingCandidate['status'];revision:number;created_at:Date;source_check:unknown;next_source_check_at:Date|null;check_job_state:string|null;[key:string]:unknown }
const denied = (context:RepositoryContext):boolean => !decideAdminOnly(context).permitted;
export function candidateIdentityKey(input:CandidateInput):string {
  const url = new URL(input.website);
  const website = `${url.hostname.replace(/^www\./,'')}${url.pathname.replace(/\/+$/,'')}`;
  const fold = (value:string) => value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
  // Preserve branch paths and locality. Sharing a host does not prove firm identity.
  return createHash('sha256').update(JSON.stringify([website,fold(input.firmName),fold(input.locality),input.region])).digest('hex');
}
export async function saveCandidate(context:RepositoryContext,input:CandidateInput):Promise<Result<{id:string;duplicate:boolean}>> {
  if(denied(context)) return {ok:false,reason:'admin_only'};
  const parsed=candidateInputSchema.safeParse(input);
  if(!parsed.success || parsed.data.observedOn > (await databaseNow(context)).slice(0,10)) return {ok:false,reason:'invalid_input'};
  // Historical keys omit queries. Refuse unsupported query identity rather than silently
  // collapsing distinct offices or rewriting existing keys/provenance.
  if(new URL(parsed.data.website).search&&verifiedWebsiteKey(parsed.data.website)===null)return {ok:false,reason:'invalid_input'};
  const key=candidateIdentityKey(parsed.data);
  const inserted=await context.db.query<{id:string}>(
    `INSERT INTO sourcing_candidates(workspace_id,identity_key,payload) VALUES($1,$2,$3::jsonb)
     ON CONFLICT (workspace_id,identity_key) DO NOTHING RETURNING id`,
    [context.scope.workspaceId,key,JSON.stringify(parsed.data)]);
  const id=inserted.rows[0]?.id;
  if(id === undefined) {
    const existing=await context.db.query<{id:string}>('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND identity_key=$2',[context.scope.workspaceId,key]);
    const existingId=existing.rows[0]?.id;
    return existingId === undefined ? {ok:false,reason:'candidate_changed'} : {ok:true,value:{id:existingId,duplicate:true}};
  }
  await recordCrmAuditEvent(context,{action:'sourcing.candidate_saved',subjectKind:'sourcing_candidate',subjectId:id});
  return {ok:true,value:{id,duplicate:false}};
}
export async function listCandidates(context:RepositoryContext,input:z.infer<typeof candidateListInputSchema>):Promise<Result<z.infer<typeof candidateListSchema>>> {
  if(denied(context)) return {ok:false,reason:'admin_only'};
  if(!candidateListInputSchema.safeParse(input).success) return {ok:false,reason:'invalid_input'};
  const automatic=await verifiedFirmOwner(context)!==null;
  const {rows}=await context.db.query<Row&{review_reason:string|null}>(
    `SELECT c.*,CASE WHEN c.qualification_blocked THEN 'identity_unresolved' WHEN last.admission_reason=ANY($5::text[]) THEN last.admission_reason ELSE NULL END AS review_reason,
     (SELECT state FROM jobs j WHERE j.workspace_id=c.workspace_id AND j.id::text=c.source_check->>'jobId') AS check_job_state
     FROM sourcing_candidates c LEFT JOIN LATERAL (SELECT admission_reason FROM sourcing_qualification_runs r WHERE r.workspace_id=c.workspace_id AND r.candidate_id=c.id AND r.candidate_revision=c.revision ORDER BY requested_at DESC,id DESC LIMIT 1) last ON true
     WHERE c.workspace_id=$1 AND c.payload->>'kind' IS DISTINCT FROM 'discovery-v1' AND CASE WHEN $4 AND $2='needs_review' THEN c.status<>'dismissed' AND (c.qualification_blocked OR COALESCE(last.admission_reason=ANY($5::text[]),false)) ELSE c.status=$2 END
     ORDER BY c.created_at DESC,c.id DESC LIMIT 51 OFFSET $3`,
    [context.scope.workspaceId,input.status,input.offset,automatic,IDENTITY_REVIEW_REASONS]);
  const discovery=(await context.db.query<{enabled:boolean;next_run_at:Date;last_result:string|null;qualification_wait_reason:string|null;configured:boolean;daily_used:number;monthly_used:number;halted:boolean}>(`SELECT s.enabled,s.next_run_at,s.last_result,s.qualification_wait_reason,a.id IS NOT NULL AS configured,COALESCE(a.halted,true) AS halted,CASE WHEN a.day=(now() AT TIME ZONE 'UTC')::date THEN a.daily_used ELSE 0 END AS daily_used,CASE WHEN a.month=date_trunc('month',now() AT TIME ZONE 'UTC')::date THEN a.monthly_used ELSE 0 END AS monthly_used FROM sourcing_discovery_settings s LEFT JOIN sourcing_search_account a ON a.id=true WHERE s.workspace_id=$1`,[context.scope.workspaceId])).rows[0];
  const remaining=discovery?.configured?discoveryQuotaRemaining(discovery.daily_used,discovery.monthly_used):{daily:0,monthly:0};
  return {ok:true,value:{qualificationWaitReason:discovery?.qualification_wait_reason??null,discovery:discovery?{enabled:discovery.enabled,nextRunAt:discovery.next_run_at.toISOString(),lastResult:discovery.last_result,dailyRemaining:remaining.daily,monthlyRemaining:remaining.monthly,halted:discovery.halted}:null,hasMore:rows.length>50,candidates:rows.slice(0,50).map(row=>candidateSchema.parse({...row.payload,nextSourceCheckAt:row.next_source_check_at?.toISOString()??null,sourceCheck:visibleSourceCheck(row.source_check,row.check_job_state),id:row.id,status:row.status,revision:row.revision,createdAt:row.created_at.toISOString()}))}};
}
async function change(context:RepositoryContext,input:z.infer<typeof candidateDeleteInputSchema>,status:SourcingCandidate['status']|null):Promise<Result<{id:string}>> {
  if(denied(context)) return {ok:false,reason:'admin_only'};
  if(!candidateDeleteInputSchema.safeParse({id:input.id,expectedRevision:input.expectedRevision}).success) return {ok:false,reason:'invalid_input'};
  await lockLivePreparationCleanup(context);
  const {rows}=await context.db.query<Row>('SELECT id,revision,payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.id]);
  if(rows[0]===undefined)return {ok:false,reason:'not_found'};
  if(rows[0].revision!==input.expectedRevision)return {ok:false,reason:'candidate_changed'};
  if(status==='kept'&&!isCurrentPreparedCandidatePayload(rows[0].payload))return {ok:false,reason:'candidate_format_not_supported'};
  // Revision in the mutation also guards callers that do not hold a transaction.
  const changed=status===null
    ? await context.db.query('DELETE FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING id',[context.scope.workspaceId,input.id,input.expectedRevision])
    : await context.db.query(`UPDATE sourcing_candidates SET next_source_check_at=CASE WHEN $4='kept' THEN COALESCE(next_source_check_at,now()) ELSE NULL END,status=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING id`,[context.scope.workspaceId,input.id,input.expectedRevision,status]);
  if(changed.rows.length===0)return {ok:false,reason:'candidate_changed'};
  await recordCrmAuditEvent(context,{action:status===null?'sourcing.candidate_deleted':'sourcing.candidate_reviewed',subjectKind:'sourcing_candidate',subjectId:input.id,detail:status===null?{}:{status}});
  return {ok:true,value:{id:input.id}};
}
export async function reviewCandidate(context:RepositoryContext,input:z.infer<typeof candidateReviewInputSchema>):Promise<Result<{id:string}>> {
  if(!candidateReviewInputSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
  return await change(context,input,input.status);
}
export async function deleteCandidate(context:RepositoryContext,input:z.infer<typeof candidateDeleteInputSchema>):Promise<Result<{id:string}>> {
  return await change(context,input,null);
}
