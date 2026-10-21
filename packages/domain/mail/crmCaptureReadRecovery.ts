import { crmCaptureReadRecoveryStatusSchema, crmCaptureReadRecoveryAcknowledgmentSchema, type CrmCaptureReadRecoveryPayload, type CrmCaptureReadRecoveryAttempt } from '@fss/contracts';
import { captureReadAuthority } from './crmCaptureReadAuthority.ts';
import type { CrmCapabilityRuntime } from '../crm/capabilityAuthority.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';

export type RecoveryRow = {
 id:string;mailbox_id:string;generation:number;incident_id:string;requester_user_id:string;owner_user_id:string;
 owner_approval_id:string;controls_revision:number;policy_revision:number;recovery_binding_sha256:string;
 state:CrmCaptureReadRecoveryAttempt['state'];coded_outcome:CrmCaptureReadRecoveryAttempt['reason'];
 requested_at:Date;probe_started_at:Date|null;completed_at:Date|null;
};
function attempt(row:RecoveryRow):CrmCaptureReadRecoveryAttempt {return {attemptId:row.id,state:row.state,reason:row.coded_outcome,requestedAt:row.requested_at.toISOString(),probeStartedAt:row.probe_started_at?.toISOString()??null,completedAt:row.completed_at?.toISOString()??null};}
/** Called inside normal read/command transactions. No provider work or consent writes. */
export async function readCaptureReadRecovery(context:RepositoryContext,input:{mailboxId:string},runtime?:CrmCapabilityRuntime) {
 const current=await captureReadAuthority(context,input.mailboxId,runtime);
 // Do not expose another owner's mailbox, generation or attempt to an invalid actor.
 if(!current.ok&&current.reason==='capture_authority_unavailable')return null;
 const m=(await context.db.query<{generation:number}>('SELECT generation FROM mailboxes WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.mailboxId])).rows[0];
 const row=m?(await context.db.query<RecoveryRow>('SELECT * FROM crm_capture_read_recoveries WHERE workspace_id=$1 AND mailbox_id=$2 AND generation=$3 ORDER BY requested_at DESC,id DESC LIMIT 1',[context.scope.workspaceId,input.mailboxId,m.generation])).rows[0]:undefined;
 if(row?.state==='probing'){
  const live=await context.db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND kind='crm.capture_read_recovery' AND payload->>'recoveryId'=$2 AND state='running' AND lease_expires_at>clock_timestamp() LIMIT 1",[context.scope.workspaceId,row.id]);
  if(!live.rows.length){row.state='uncertain';row.coded_outcome='provider_uncertain';}
 }
 return crmCaptureReadRecoveryStatusSchema.parse({mailboxId:input.mailboxId,generation:m?.generation??null,eligible:current.ok&&!row,incidentId:current.ok?current.authority.incidentId:null,recoveryBinding:current.ok?current.authority.binding:null,reason:row?row.coded_outcome??(row.state==='probing'?'probe_in_progress':'attempt_already_used'):current.ok?null:current.reason,attempt:row?attempt(row):null,sendingUnchanged:true,holdsUnchanged:true,providerCoverage:'unproven'});
}
export async function requestCaptureReadRecovery(context:RepositoryContext,input:CrmCaptureReadRecoveryPayload,runtime?:CrmCapabilityRuntime) {
 const actor=context.scope.actor;
 if(actor.kind!=='user')return {ok:false as const,reason:'capture_authority_unavailable'};
 const current=await captureReadAuthority(context,input.mailboxId,runtime);
 if(!current.ok)return current;
 const a=current.authority;
 if(a.generation!==input.expectedGeneration||a.incidentId!==input.incidentId||a.binding!==input.expectedRecoveryBinding)return {ok:false as const,reason:'recovery_binding_changed'};
 const w=context.scope.workspaceId;
 await context.db.query(`INSERT INTO crm_capture_read_recoveries(workspace_id,mailbox_id,generation,incident_id,requester_user_id,owner_user_id,owner_approval_id,controls_revision,policy_revision,recovery_binding_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,mailbox_id,generation,incident_id) DO NOTHING`,[w,a.mailboxId,a.generation,a.incidentId,actor.userId,a.ownerUserId,a.ownerApprovalId,a.controlsRevision,a.policyRevision,a.binding]);
 const row=(await context.db.query<RecoveryRow>('SELECT * FROM crm_capture_read_recoveries WHERE workspace_id=$1 AND mailbox_id=$2 AND generation=$3 AND incident_id=$4',[w,a.mailboxId,a.generation,a.incidentId])).rows[0]!;
 if(row.state==='queued')await enqueueJob(context.db,{workspaceId:w,kind:'crm.capture_read_recovery',idempotencyKey:`capture-read-recovery:${row.id}`,payload:{recoveryId:row.id},maxAttempts:1});
 return {ok:true as const,value:crmCaptureReadRecoveryAcknowledgmentSchema.parse({attemptId:row.id,state:row.state,sendingUnchanged:true,holdsUnchanged:true})};
}
