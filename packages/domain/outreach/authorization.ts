import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
export interface ProspectingIdentity {mailboxId:string;ownerUserId:string;providerAccountId:string}
export interface ProspectingAuthorization {allowed:boolean;revision:number|null;reason:string|null}
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
/** Caller transaction; changing this authority is a stop fact for an in-flight claim. */
export async function setProspectingAuthorization(ctx:RepositoryContext,input:{mailboxId:string;expectedRevision:number;enabled:boolean;basis:'owner_reported_google_permission'}):Promise<Result<{revision:number}>>{
 const actor=ctx.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return {ok:false,reason:'admin_required'};
 if(input.basis!=='owner_reported_google_permission'||!Number.isInteger(input.expectedRevision)||input.expectedRevision<0)return {ok:false,reason:'invalid_input'};
 await lockSendGateForStopFact(ctx);
 const w=ctx.scope.workspaceId;
 const mailbox=(await ctx.db.query<{owner_user_id:string;provider_account_id:string|null;email_address:string;status:string}>(
  'SELECT owner_user_id,provider_account_id,email_address,status FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.mailboxId])).rows[0];
 if(!mailbox)return {ok:false,reason:'not_found'};
 if(input.enabled&&(mailbox.status!=='connected'||!mailbox.provider_account_id))return {ok:false,reason:'mailbox_not_connected'};
 const current=(await ctx.db.query<{revision:number}>('SELECT revision FROM gmail_prospecting_authorizations WHERE workspace_id=$1 AND mailbox_id=$2',[w,input.mailboxId])).rows[0];
 if((current?.revision??0)!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 // Revocation must remain possible after disconnection; preserve the last bound identity.
 if(!mailbox.provider_account_id&&!current)return {ok:false,reason:'mailbox_not_connected'};
 const revision=input.expectedRevision+1;
 await ctx.db.query(`INSERT INTO gmail_prospecting_authorizations(workspace_id,mailbox_id,owner_user_id,provider_account_id,email_address,revision,enabled,basis,reported_by,enabled_at,revoked_at)
 VALUES($1,$2,$3,COALESCE($4,(SELECT provider_account_id FROM gmail_prospecting_authorizations WHERE workspace_id=$1 AND mailbox_id=$2)),$5,$6,$7,$8,$9,CASE WHEN $7 THEN now() END,CASE WHEN NOT $7 THEN now() END)
 ON CONFLICT(workspace_id,mailbox_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,provider_account_id=EXCLUDED.provider_account_id,email_address=EXCLUDED.email_address,revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,basis=EXCLUDED.basis,reported_by=EXCLUDED.reported_by,enabled_at=EXCLUDED.enabled_at,revoked_at=EXCLUDED.revoked_at,updated_at=now()`,
 [w,input.mailboxId,mailbox.owner_user_id,mailbox.provider_account_id,mailbox.email_address,revision,input.enabled,input.basis,actor.userId]);
 await recordCrmAuditEvent(ctx,{action:'outreach.authorization_changed',subjectKind:'mailbox',subjectId:input.mailboxId,detail:{revision,enabled:input.enabled,basis:input.basis}});
 return {ok:true,value:{revision}};
}
/** Rechecks the live OAuth identity; refreshing tokens for that same identity is harmless. */
export async function readProspectingAuthorization(ctx:RepositoryContext,input:ProspectingIdentity):Promise<ProspectingAuthorization>{
 const row=(await ctx.db.query<{revision:number;enabled:boolean;matches:boolean}>(`SELECT a.revision,a.enabled,
  m.status='connected' AND a.owner_user_id=m.owner_user_id AND a.provider_account_id=m.provider_account_id
  AND a.email_address=m.email_address AND m.owner_user_id=$3 AND m.provider_account_id=$4 AS matches
  FROM gmail_prospecting_authorizations a JOIN mailboxes m ON m.workspace_id=a.workspace_id AND m.id=a.mailbox_id
  WHERE a.workspace_id=$1 AND a.mailbox_id=$2`,[ctx.scope.workspaceId,input.mailboxId,input.ownerUserId,input.providerAccountId])).rows[0];
 if(!row)return {allowed:false,revision:null,reason:'authorization_absent'};
 if(!row.enabled)return {allowed:false,revision:row.revision,reason:'authorization_revoked'};
 if(!row.matches)return {allowed:false,revision:row.revision,reason:'mailbox_identity_changed'};
 return {allowed:true,revision:row.revision,reason:null};
}
export async function authorizationForMailbox(ctx:RepositoryContext,mailboxId:string):Promise<ProspectingAuthorization>{
 const m=(await ctx.db.query<{owner_user_id:string;provider_account_id:string|null}>('SELECT owner_user_id,provider_account_id FROM mailboxes WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,mailboxId])).rows[0];
 if(!m?.provider_account_id)return {allowed:false,revision:null,reason:'mailbox_identity_unknown'};
 return readProspectingAuthorization(ctx,{mailboxId,ownerUserId:m.owner_user_id,providerAccountId:m.provider_account_id});
}
/** Freeze an existing authorization on newly prepared cold bytes; never retrofit old fences. */
export async function bindProspectingFence(ctx:RepositoryContext,input:{fenceId:string;mailboxId:string;stepExecutionId:string}):Promise<void>{
 const origin=(await ctx.db.query<{origin_kind:string}>(`SELECT e.origin_kind FROM step_executions s JOIN sequence_enrollments e ON e.workspace_id=s.workspace_id AND e.id=s.enrollment_id WHERE s.workspace_id=$1 AND s.id=$2`,[ctx.scope.workspaceId,input.stepExecutionId])).rows[0]?.origin_kind;
 if(origin!=='prospecting')return;
 const auth=await authorizationForMailbox(ctx,input.mailboxId);if(!auth.allowed||auth.revision===null)return;
 await ctx.db.query(`INSERT INTO outreach_fence_authorizations(workspace_id,fence_id,mailbox_id,authorization_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[ctx.scope.workspaceId,input.fenceId,input.mailboxId,auth.revision]);
}
export async function verifyProspectingFence(ctx:RepositoryContext,input:{fenceId:string;mailboxId:string}):Promise<boolean>{
 const auth=await authorizationForMailbox(ctx,input.mailboxId);if(!auth.allowed)return false;
 return (await ctx.db.query('SELECT 1 FROM outreach_fence_authorizations WHERE workspace_id=$1 AND fence_id=$2 AND mailbox_id=$3 AND authorization_revision=$4',[ctx.scope.workspaceId,input.fenceId,input.mailboxId,auth.revision])).rows.length===1;
}
/** Restored authority predates external activity. Explicitly re-authorize after recovery. */
export async function revokeProspectingAfterRestore(ctx:RepositoryContext):Promise<number>{
 await lockSendGateForStopFact(ctx);
 const rows=(await ctx.db.query<{mailbox_id:string;revision:number}>(`UPDATE gmail_prospecting_authorizations SET enabled=false,revision=revision+1,revoked_at=now(),updated_at=now() WHERE workspace_id=$1 AND enabled RETURNING mailbox_id,revision`,[ctx.scope.workspaceId])).rows;
 for(const row of rows)await recordCrmAuditEvent(ctx,{action:'outreach.authorization_restore_revoked',subjectKind:'mailbox',subjectId:row.mailbox_id,detail:{revision:row.revision}});
 return rows.length;
}
