import { crmCapabilityConfigurationSchema, crmForwardCaptureScopeSchema, type CrmForwardCaptureScope } from '@fss/contracts';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { MailCaptureProof } from './crmSources.ts';

/** approvedAt must be the exact DB-observed ISO timestamp used for the immutable
 * owner approval, not an application clock. Date.parse floors submilliseconds;
 * adding one millisecond equals date_trunc('milliseconds', approved_at) + 1ms.
 * Select approved_at as an ISO text value when re-deriving an existing epoch.
 */
export function forwardCaptureScopeForApproval(approvedAt: string): CrmForwardCaptureScope | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(approvedAt)
    || !z.iso.datetime().safeParse(approvedAt).success) return null;
  const instant = Date.parse(approvedAt);
  if (!Number.isSafeInteger(instant) || !Number.isSafeInteger(instant + 1)) return null;
  const parsed = crmForwardCaptureScopeSchema.safeParse({
    mode: 'forward_only', enabledAt: new Date(instant + 1).toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/** Each original's provider INTERNAL date, never a conversation's latest date.
 * Invalid/missing scope and dates fail closed. Existing future-date policy is
 * independently retained at metadata admission and fresh provider validation.
 */
export function isForwardCaptureDateAllowed(scope: CrmForwardCaptureScope, internalDateEpochMilliseconds: number): boolean {
  const parsed = crmForwardCaptureScopeSchema.safeParse(scope);
  return parsed.success && Number.isSafeInteger(internalDateEpochMilliseconds)
    && internalDateEpochMilliseconds >= Date.parse(parsed.data.enabledAt);
}

export function sameForwardCaptureScope(a: CrmForwardCaptureScope, b: CrmForwardCaptureScope): boolean {
  const left = crmForwardCaptureScopeSchema.safeParse(a);
  const right = crmForwardCaptureScopeSchema.safeParse(b);
  return left.success && right.success && left.data.enabledAt === right.data.enabledAt;
}

/** Immutable audit is the epoch, not a caller-supplied or mutable timestamp. */
export async function readForwardCaptureApproval(context: RepositoryContext, approvalId: unknown) {
  if (typeof approvalId !== 'string') return null;
  const row = (await context.db.query<{ configuration_sha256: string; scope_configuration: unknown; approved_at: string }>(
    `SELECT configuration_sha256,scope_configuration,to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS approved_at FROM crm_capability_owner_approvals WHERE workspace_id=$1 AND id=$2 AND capability='mail_capture'`,
    [context.scope.workspaceId, approvalId],
  )).rows[0];
  if (!row) return null;
  const parsed = crmCapabilityConfigurationSchema.safeParse(row.scope_configuration);
  const scope = forwardCaptureScopeForApproval(row.approved_at);
  if (!parsed.success || parsed.data.capability !== 'mail_capture' || !scope || !parsed.data.forwardScope
    || !sameForwardCaptureScope(scope, parsed.data.forwardScope)
    || createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex') !== row.configuration_sha256) return null;
  return { configuration: parsed.data, scope };
}

export async function forwardScopeForControl(context: RepositoryContext, control: Record<string, unknown>) {
  const approval = await readForwardCaptureApproval(context, control['owner_approval_id']);
  if (!approval) return null;
  const c = approval.configuration;
  return c.workspaceId === context.scope.workspaceId && c.mailboxId === control['mailbox_id']
    && c.ownerUserId === control['owner_user_id'] && c.providerAccountId === control['provider_account_id']
    && c.accountBinding === control['account_binding'] && c.generation === control['generation']
    && c.revision === control['revision'] && c.policyRevision === control['policy_revision'] ? approval.scope : null;
}

/** Shared body-free proof composition keeps every worker/read path on one epoch. */
export async function captureProofForControl(context: RepositoryContext, mailboxId: string, control: {
  owner_user_id: string; provider_account_id: string; account_binding: string; generation: number;
  revision: number; policy_revision: number; disclosure_version: string; disclosure_sha256: string;
  owner_approval_id: string | null; grant_receipt: string | null; provider_policy_receipt: string | null;
  evaluation_receipt: string | null; release_receipt: string | null;
}): Promise<MailCaptureProof> {
  const forwardScope = await forwardScopeForControl(context, { ...control, mailbox_id: mailboxId });
  return { workspaceId: context.scope.workspaceId, mailboxId, ownerUserId: control.owner_user_id,
    providerAccountId: control.provider_account_id, accountBinding: control.account_binding,
    generation: control.generation, controlsRevision: control.revision, policyRevision: control.policy_revision,
    disclosureVersion: control.disclosure_version, disclosureSha256: control.disclosure_sha256,
    grantReceipt: control.grant_receipt, providerPolicyReceipt: control.provider_policy_receipt,
    evaluationReceipt: control.evaluation_receipt, releaseReceipt: control.release_receipt,
    ...control.owner_approval_id ? { ownerApprovalId: control.owner_approval_id } : {},
    ...forwardScope ? { forwardScope } : {}, captureVersion: 'crm-mail-capture-v1' };
}

/** Never reconstruct fresh processing authority for a retained pre-epoch copy. */
export async function forwardMailSourceAllowed(context: RepositoryContext, source: Record<string, unknown>, control: Record<string, unknown>) {
  const approval = await readForwardCaptureApproval(context, control['owner_approval_id']);
  if (!approval || !await forwardScopeForControl(context, control)) return false;
  const c = approval.configuration;
  const at = source['provider_at'];
  const receipts = source['verification_receipts'];
  if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)
    || !('authorizationKind' in receipts) || receipts.authorizationKind !== 'owner_consent'
    || !('ownerApprovalId' in receipts) || receipts.ownerApprovalId !== control['owner_approval_id']) return false;
  return source['mailbox_id'] === c.mailboxId && source['owner_user_id'] === c.ownerUserId
    && source['provider_account_id'] === c.providerAccountId && source['account_binding'] === c.accountBinding
    && source['acquired_generation'] === c.generation && source['controls_revision'] === c.revision
    && isForwardCaptureDateAllowed(approval.scope, at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : NaN);
}

/** Called before metadata becomes a new CRM conversation, not only before body intent. */
export async function forwardObservationAllowed(context: RepositoryContext, mailboxId: string, providerAt: string, acquisitionOrigin?: unknown) {
  if(acquisitionOrigin!==undefined)return false;
  const control = (await context.db.query<Record<string,unknown>>('SELECT * FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2 FOR SHARE',[context.scope.workspaceId,mailboxId])).rows[0];
  const scope = control?.['enabled'] ? await forwardScopeForControl(context,control) : null;
  return !!scope && isForwardCaptureDateAllowed(scope,Date.parse(providerAt));
}
