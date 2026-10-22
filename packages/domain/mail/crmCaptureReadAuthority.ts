import { createHash } from 'node:crypto';
import { verifyCurrentCrmCapability, type CrmCapabilityRuntime } from '../crm/capabilityAuthority.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';

export type CaptureRecoveryReason = 'capture_authority_unavailable' | 'mailbox_binding_changed' | 'incident_not_eligible' | 'additional_incident';
export interface CaptureReadAuthority {
  mailboxId: string; generation: number; ownerUserId: string; providerAccountId: string;
  mailboxEmail: string; ownerApprovalId: string; controlsRevision: number; policyRevision: number;
  incidentId: string; binding: string; cutoff: string;
}
/** All reads are local and caller-transaction owned. No sending authority is consulted.
 * Lock order: mailbox, membership, capability, token, incidents. The opaque binding
 * includes every open read incident, never token plaintext or provider payloads.
 */
export async function captureReadAuthority(context: RepositoryContext, mailboxId: string, runtime?: CrmCapabilityRuntime): Promise<{ok:true; authority:CaptureReadAuthority}|{ok:false;reason:CaptureRecoveryReason}> {
  const w = context.scope.workspaceId;
  const m = (await context.db.query<{id:string;owner_user_id:string;provider_account_id:string|null;email_address:string;generation:number;status:string}>(
    'SELECT id,owner_user_id,provider_account_id,email_address,generation,status FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR SHARE', [w,mailboxId])).rows[0];
  if (!m) return {ok:false,reason:'capture_authority_unavailable'};
  const owner = (await context.db.query<{role:'admin'|'salesperson';status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[w,m.owner_user_id])).rows[0];
  if (owner?.status !== 'active') return {ok:false,reason:'capture_authority_unavailable'};
  const actor=context.scope.actor;
  if(actor.kind==='user') {
    const requester=(await context.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[w,actor.userId])).rows[0];
    if(requester?.status!=='active'||requester.role!==actor.role||(actor.userId!==m.owner_user_id&&actor.role!=='admin'))return {ok:false,reason:'capture_authority_unavailable'};
  } else if(actor.component!=='worker')return {ok:false,reason:'capture_authority_unavailable'};
  if(m.status!=='connected'||!m.provider_account_id)return {ok:false,reason:'mailbox_binding_changed'};
  // Reconstruct only the actual active stored owner, never a caller-supplied owner.
  const owned=repositoryContext(workspaceScope(w,{kind:'user',userId:m.owner_user_id,role:owner.role}),context.db);
  const receipt=await verifyCurrentCrmCapability(owned,{capability:'mail_capture',mailboxId},runtime);
  const c=receipt?.configuration;
  if(!receipt||!c||c.capability!=='mail_capture'||!c.forwardScope)return {ok:false,reason:'capture_authority_unavailable'};
  const token=(await context.db.query<{metadata:unknown}>(`SELECT jsonb_build_array(created_at,rotated_at,key_id,algorithm,encode(sha256(ciphertext),'hex')) AS metadata FROM mailbox_tokens WHERE workspace_id=$1 AND mailbox_id=$2 FOR SHARE`,[w,mailboxId])).rows[0];
  if(!token)return {ok:false,reason:'capture_authority_unavailable'};
  const incidents=(await context.db.query<{id:string;source_kind:string;classification:string;reason:string;retry_at:Date|null;snapshot:unknown}>(`SELECT id,source_kind,classification,reason,retry_at,to_jsonb(i) AS snapshot FROM mailbox_provider_incidents i WHERE workspace_id=$1 AND mailbox_id=$2 AND resolved_at IS NULL ORDER BY id FOR SHARE`,[w,mailboxId])).rows;
  if(incidents.length>1)return {ok:false,reason:'additional_incident'};
  const incident=incidents[0];
  if(!incident||incident.source_kind!=='token_refresh'||incident.classification!=='transient'||incident.reason!=='rate_limited'||incident.retry_at!==null)return {ok:false,reason:'incident_not_eligible'};
  const binding=createHash('sha256').update(JSON.stringify([w,m,c,receipt.ownerApprovalId,token.metadata,incidents.map(i=>i.snapshot)])).digest('hex');
  return {ok:true,authority:{mailboxId,generation:m.generation,ownerUserId:m.owner_user_id,providerAccountId:m.provider_account_id,mailboxEmail:m.email_address,ownerApprovalId:receipt.ownerApprovalId,controlsRevision:c.revision,policyRevision:c.policyRevision,incidentId:incident.id,binding,cutoff:c.forwardScope.enabledAt}};
}
