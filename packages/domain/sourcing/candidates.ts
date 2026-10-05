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

type Result<T> = {ok:true;value:T} | {ok:false;reason:string};
interface Row { id:string;payload:CandidateInput;status:SourcingCandidate['status'];revision:number;created_at:Date;source_check:unknown;next_source_check_at:Date|null;check_job_state:string|null;[key:string]:unknown }
const denied = (context:RepositoryContext):boolean => !decideAdminOnly(context).permitted;
function identity(input:CandidateInput):string {
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
  const key=identity(parsed.data);
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
  const {rows}=await context.db.query<Row>(
    `SELECT id,payload,status,revision,created_at,source_check,next_source_check_at,(SELECT state FROM jobs j WHERE j.workspace_id=sourcing_candidates.workspace_id AND j.id::text=source_check->>'jobId') AS check_job_state FROM sourcing_candidates WHERE workspace_id=$1 AND status=$2 ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET $3`,
    [context.scope.workspaceId,input.status,input.offset]);
  return {ok:true,value:{hasMore:rows.length>50,candidates:rows.slice(0,50).map(row=>candidateSchema.parse({...row.payload,nextSourceCheckAt:row.next_source_check_at?.toISOString()??null,sourceCheck:visibleSourceCheck(row.source_check,row.check_job_state),id:row.id,status:row.status,revision:row.revision,createdAt:row.created_at.toISOString()}))}};
}
async function change(context:RepositoryContext,input:z.infer<typeof candidateDeleteInputSchema>,status:SourcingCandidate['status']|null):Promise<Result<{id:string}>> {
  if(denied(context)) return {ok:false,reason:'admin_only'};
  if(!candidateDeleteInputSchema.safeParse({id:input.id,expectedRevision:input.expectedRevision}).success) return {ok:false,reason:'invalid_input'};
  const {rows}=await context.db.query<Row>('SELECT id,revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.id]);
  if(rows[0]===undefined)return {ok:false,reason:'not_found'};
  if(rows[0].revision!==input.expectedRevision)return {ok:false,reason:'candidate_changed'};
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
