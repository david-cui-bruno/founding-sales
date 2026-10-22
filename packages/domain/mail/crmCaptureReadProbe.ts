import { z } from 'zod';
import { captureReadAuthority, type CaptureReadAuthority } from './crmCaptureReadAuthority.ts';
import type { RecoveryRow } from './crmCaptureReadRecovery.ts';
import { repositoryContext, type RepositoryContext } from '../db/workspaceScope.ts';
import { withTransaction } from '../db/queryable.ts';
import type { JobHandlerInput } from '../jobs/handlerRegistry.ts';
import type { CrmCapabilityRuntime } from '../crm/capabilityAuthority.ts';
import type { GmailClient, GmailOAuthConfig } from './gmailClient.ts';
import type { EnvelopeCipher } from './envelope.ts';
import { readRefreshToken } from './tokens.ts';
import { enqueueJob } from '../jobs/jobStore.ts';

export interface CaptureReadProbeDeps {gmail:GmailClient;oauth:GmailOAuthConfig;cipher:EnvelopeCipher;runtime:CrmCapabilityRuntime}
export const captureRecoveryJobPayload=z.strictObject({recoveryId:z.uuid()});
export async function lockCaptureReadJob(input:JobHandlerInput):Promise<boolean>{
 if(input.scope.actor.kind!=='system'||input.scope.actor.component!=='worker'||input.job.workspaceId!==input.scope.workspaceId)return false;
 return (await input.session.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE`,[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken])).rows.length===1;
}
export async function recoveryCurrent(context:RepositoryContext,row:RecoveryRow,runtime:CrmCapabilityRuntime):Promise<CaptureReadAuthority|null>{
 const a=await captureReadAuthority(context,row.mailbox_id,runtime);
 if(!a.ok||a.authority.binding!==row.recovery_binding_sha256||a.authority.ownerApprovalId!==row.owner_approval_id||a.authority.ownerUserId!==row.owner_user_id||a.authority.generation!==row.generation||a.authority.incidentId!==row.incident_id)return null;
 const requester=(await context.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[context.scope.workspaceId,row.requester_user_id])).rows[0];
 return requester?.status==='active'&&(row.requester_user_id===row.owner_user_id||requester.role==='admin')?a.authority:null;
}
/** Durable probing commits before decryption or OAuth. A reclaimed probing row is
 * uncertain, never dispatched again, regardless of queue or command identifiers. */
export async function runCaptureReadProbe(input:JobHandlerInput,deps:CaptureReadProbeDeps|undefined):Promise<void>{
 const payload=captureRecoveryJobPayload.parse(input.job.payload);
 const ctx=repositoryContext(input.scope,input.session),w=input.scope.workspaceId;
 const start=await withTransaction(input.session,async()=>{
  if(!await lockCaptureReadJob(input))return null;
  const row=(await ctx.db.query<RecoveryRow>('SELECT * FROM crm_capture_read_recoveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,payload.recoveryId])).rows[0];
  if(!row||!['queued','probing'].includes(row.state))return null;
  if(row.state==='probing'){
   await ctx.db.query("UPDATE crm_capture_read_recoveries SET state='uncertain',coded_outcome='provider_uncertain',completed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[w,row.id]);return null;
  }
  const a=deps?await recoveryCurrent(ctx,row,deps.runtime):null;
  if(!a){await ctx.db.query("UPDATE crm_capture_read_recoveries SET state='stale',coded_outcome=$3,completed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[w,row.id,deps?'recovery_binding_changed':'capture_consumer_unavailable']);return null;}
  await ctx.db.query("UPDATE crm_capture_read_recoveries SET state='probing',probe_started_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[w,row.id]);return {row,authority:a};
 });
 if(!start||!deps)return;
 async function current(){return withTransaction(input.session,async()=>await lockCaptureReadJob(input)?recoveryCurrent(ctx,start!.row,deps!.runtime):null);}
 let state:'verified'|'refused'|'uncertain'|'stale'='uncertain';
 let reason:'capture_read_verified'|'provider_refused'|'provider_uncertain'|'profile_identity_mismatch'|'recovery_binding_changed'='provider_uncertain';
 try{
  const token=await readRefreshToken(ctx,{mailboxId:start.row.mailbox_id,cipher:deps.cipher});
  if(!await current()){state='stale';reason='recovery_binding_changed';}
  else if(token===null){state='refused';reason='provider_refused';}
  else {
   const refreshed=await deps.gmail.refreshAccessToken(deps.oauth,token);
   if(!await current()){state='stale';reason='recovery_binding_changed';}
   else if(!refreshed.ok){state='refused';reason='provider_refused';}
   else if(!Number.isFinite(refreshed.grant.expiresAtEpochSeconds)||refreshed.grant.expiresAtEpochSeconds<=Date.now()/1000||refreshed.grant.grantedScopes&&!refreshed.grant.grantedScopes.includes('https://www.googleapis.com/auth/gmail.readonly')){state='refused';reason='provider_refused';}
   else {
    const profile=await deps.gmail.getProfile(refreshed.grant);
    if(typeof profile.emailAddress!=='string'||profile.emailAddress.toLowerCase()!==start.authority.mailboxEmail.toLowerCase()){state='refused';reason='profile_identity_mismatch';}
    else {state='verified';reason='capture_read_verified';}
   }
  }
 }catch{/* Raw provider exceptions must never enter audit, logs or command results. */}
 await withTransaction(input.session,async()=>{
  if(!await lockCaptureReadJob(input))return;
  const row=(await ctx.db.query<RecoveryRow>("SELECT * FROM crm_capture_read_recoveries WHERE workspace_id=$1 AND id=$2 AND state='probing' FOR UPDATE",[w,start.row.id])).rows[0];
  if(!row)return;
  const a=await recoveryCurrent(ctx,row,deps.runtime);
  if(!a){state='stale';reason='recovery_binding_changed';}
  await ctx.db.query('UPDATE crm_capture_read_recoveries SET state=$3,coded_outcome=$4,completed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[w,row.id,state,reason]);
  if(state==='verified'&&a){
   await ctx.db.query(`INSERT INTO crm_capture_read_progress(workspace_id,recovery_id,mailbox_id,generation,forward_cutoff_at,window_from_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING`,[w,row.id,a.mailboxId,a.generation,a.cutoff]);
   await enqueueJob(ctx.db,{workspaceId:w,kind:'crm.capture_read_forward',idempotencyKey:`capture-read-forward:${row.id}:initial`,payload:{recoveryId:row.id},maxAttempts:1});
  }
 });
}
