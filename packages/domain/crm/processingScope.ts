import { crmExtractionSourceScopeSchema, type CrmExtractionSourceScope } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { forwardMailSourceAllowed, readForwardCaptureApproval } from '../mail/crmForwardCaptureScope.ts';

/** Syntax is not owner/account/epoch authority. Callers separately revalidate
 * the bound capture approval before any original read or model dispatch.
 */
export function crmExtractionSourceAllowed(scope: CrmExtractionSourceScope, kind: string): boolean {
  const parsed = crmExtractionSourceScopeSchema.safeParse(scope);
  return parsed.success && kind === 'mail' && parsed.data.allowedSourceKinds.length === 1
    && parsed.data.mailCaptureOwnerApprovalId !== null;
}

export function extractionScopeFromRow(row: Record<string, unknown> | undefined): CrmExtractionSourceScope {
  const parsed = crmExtractionSourceScopeSchema.safeParse({ allowedSourceKinds: row?.['allowed_source_kinds'],
    mailCaptureOwnerApprovalId: row?.['mail_capture_owner_approval_id'] });
  return parsed.success ? parsed.data : { allowedSourceKinds: [], mailCaptureOwnerApprovalId: null };
}

/** Fresh current capture binding is needed even for disabled purpose preparation. */
export async function currentExtractionCaptureBinding(context: RepositoryContext, approvalId: string) {
  if (context.scope.actor.kind !== 'user') return false;
  const approval = await readForwardCaptureApproval(context, approvalId);
  if (!approval || approval.configuration.ownerUserId !== context.scope.actor.userId) return false;
  const c = approval.configuration;
  return (await context.db.query(`SELECT 1 FROM crm_mail_capture_controls x JOIN mailboxes m ON m.workspace_id=x.workspace_id AND m.id=x.mailbox_id JOIN crm_business_policies p ON p.workspace_id=x.workspace_id AND p.mailbox_id=x.mailbox_id WHERE x.workspace_id=$1 AND x.mailbox_id=$2 AND x.owner_approval_id=$3 AND x.enabled AND x.revision=$4 AND x.generation=$5 AND x.account_binding=$6 AND x.provider_account_id=$7 AND x.owner_user_id=$8 AND m.status='connected' AND m.generation=x.generation AND m.provider_account_id=x.provider_account_id AND m.owner_user_id=x.owner_user_id AND p.enabled AND p.revision=x.policy_revision AND p.owner_approval_id IS NOT NULL FOR SHARE OF x,m,p`,
    [context.scope.workspaceId,c.mailboxId,approvalId,c.revision,c.generation,c.accountBinding,c.providerAccountId,c.ownerUserId])).rows.length === 1;
}

/** Admission, dispatch and publication all use the real DB source and purpose. */
export async function mailExtractionScopeAllows(context: RepositoryContext, input: { kind: string; sourceId: string }, purpose?: Record<string, unknown>) {
  const row = purpose ?? (await context.db.query<Record<string, unknown>>('SELECT * FROM crm_extraction_purposes WHERE workspace_id=$1 FOR SHARE',[context.scope.workspaceId])).rows[0];
  const scope = extractionScopeFromRow(row);
  if (!row?.['enabled'] || !crmExtractionSourceAllowed(scope,input.kind) || !scope.mailCaptureOwnerApprovalId
    || !await currentExtractionCaptureBinding(context,scope.mailCaptureOwnerApprovalId)) return false;
  const source = (await context.db.query<Record<string,unknown>>('SELECT * FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 AND availability=\'available\' AND diagnostic_authorization_id IS NULL',[context.scope.workspaceId,input.sourceId])).rows[0];
  if (!source || context.scope.actor.kind !== 'user' || source['owner_user_id'] !== context.scope.actor.userId) return false;
  const control = (await context.db.query<Record<string,unknown>>('SELECT * FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2 AND owner_approval_id=$3',[context.scope.workspaceId,source['mailbox_id'],scope.mailCaptureOwnerApprovalId])).rows[0];
  return !!control && await forwardMailSourceAllowed(context,source,control);
}
