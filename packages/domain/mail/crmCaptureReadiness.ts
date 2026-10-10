import { createHash } from 'node:crypto';
import { withTransaction } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { businessAccountBinding } from '../business/acquisition.ts';
import { readMailCaptureControls, MAIL_CAPTURE_VERSION, type MailCaptureProof, type MailCaptureProofVerifier } from './crmSources.ts';

export interface MailCaptureReadiness {
  /** Presence of the exact route, not permission to use it or proof of provider acceptance. */
  adapterAvailable(proof: MailCaptureProof): boolean;
  proofVerifier: MailCaptureProofVerifier;
}
function available(deps: MailCaptureReadiness, proof: MailCaptureProof) {
  try { return deps.adapterAvailable(structuredClone(proof)) === true; } catch { return false; }
}
async function snapshot(context: RepositoryContext, mailboxId?: string) {
  const controls = await readMailCaptureControls(context, mailboxId);
  if (controls === null) return null;
  const row = (await context.db.query<Record<string, unknown>>(`SELECT m.owner_user_id AS mailbox_owner,m.email_address AS mailbox_email,m.provider_account_id AS mailbox_account,m.generation AS mailbox_generation,m.status AS mailbox_status,w.status AS owner_status,c.*,p.revision AS current_policy_revision,p.account_binding AS policy_binding,p.generation AS policy_generation,p.owner_user_id AS policy_owner,p.provider_account_id AS policy_account,p.disclosure_version AS policy_disclosure_version,p.disclosure_sha256 AS policy_disclosure_sha256 FROM mailboxes m JOIN workspace_memberships w ON w.workspace_id=m.workspace_id AND w.user_id=m.owner_user_id JOIN crm_mail_capture_controls c ON c.workspace_id=m.workspace_id AND c.mailbox_id=m.id JOIN crm_business_policies p ON p.workspace_id=m.workspace_id AND p.mailbox_id=m.id WHERE m.workspace_id=$1 AND m.id=$2 FOR SHARE OF c,p`, [context.scope.workspaceId, controls.mailboxId])).rows[0];
  if (row === undefined || row['mailbox_status'] !== 'connected' || row['owner_status'] !== 'active' || typeof row['mailbox_account'] !== 'string') return { controls, proof: null, fingerprint: null };
  const binding = businessAccountBinding(context.scope.workspaceId, { id: controls.mailboxId, owner_user_id: String(row['mailbox_owner']), email_address: String(row['mailbox_email']), provider_account_id: row['mailbox_account'], generation: Number(row['mailbox_generation']), status: String(row['mailbox_status']) });
  if (binding === null || row['owner_user_id'] !== row['mailbox_owner'] || row['provider_account_id'] !== row['mailbox_account'] || row['generation'] !== row['mailbox_generation'] || row['account_binding'] !== binding || row['policy_binding'] !== binding || row['generation'] !== row['policy_generation'] || row['owner_user_id'] !== row['policy_owner'] || row['provider_account_id'] !== row['policy_account'] || row['policy_revision'] !== row['current_policy_revision']) return { controls, proof: null, fingerprint: null };
  // Metadata review and full-body capture have different disclosures. Preserve
  // both in the immutable snapshot; equality would conflate distinct authority.
  const receiptNames = ['disclosure_version', 'disclosure_sha256', 'grant_receipt', 'provider_policy_receipt', 'evaluation_receipt', 'release_receipt'] as const;
  if (receiptNames.some(name => typeof row[name] !== 'string' || String(row[name]).length === 0) || typeof row['policy_disclosure_version'] !== 'string' || typeof row['policy_disclosure_sha256'] !== 'string') return { controls, proof: null, fingerprint: null };
  const proof: MailCaptureProof = { workspaceId: context.scope.workspaceId, mailboxId: controls.mailboxId, ownerUserId: String(row['owner_user_id']), providerAccountId: row['provider_account_id'], accountBinding: binding, generation: Number(row['generation']), controlsRevision: controls.revision, policyRevision: Number(row['policy_revision']), disclosureVersion: String(row['disclosure_version']), disclosureSha256: String(row['disclosure_sha256']), grantReceipt: String(row['grant_receipt']), providerPolicyReceipt: String(row['provider_policy_receipt']), evaluationReceipt: String(row['evaluation_receipt']), releaseReceipt: String(row['release_receipt']), captureVersion: MAIL_CAPTURE_VERSION };
  return { controls, proof, fingerprint: createHash('sha256').update(JSON.stringify(row)).digest('hex') };
}
/** Body-free provider verification stays outside transactions. Readiness never activates acquisition. */
export async function readMailCaptureReadiness(context: RepositoryContext, mailboxId?: string, deps?: MailCaptureReadiness) {
  const before = await withTransaction(context.db, () => snapshot(context, mailboxId));
  if (before === null) return null;
  const fallback = { ...before.controls, ready: false };
  if (deps === undefined || before.proof === null || !available(deps, before.proof)) return fallback;
  let verified = false;
  try { verified = await deps.proofVerifier.verify(structuredClone(before.proof)) === true; } catch { /* No provider details or private content in this read. */ }
  return await withTransaction(context.db, async () => {
    const after = await snapshot(context, before.controls.mailboxId);
    if (after === null) return null;
    if (after.proof === null || after.fingerprint !== before.fingerprint || !available(deps, after.proof)) return { ...after.controls, ready: false, reason: 'binding_changed' };
    if (!verified) return { ...after.controls, ready: false };
    return { ...after.controls, ready: true, reason: after.controls.enabled ? 'ready' : 'ready_disabled' };
  });
}
