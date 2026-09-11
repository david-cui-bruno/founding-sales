import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../db/database';
import type { Clock } from '../domain/support/clock';
import { AccountRepository } from '../domain/accounts/accountRepository';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import type { ContactComplianceEvidence } from '../domain/compliance/contactComplianceTypes';
import { evaluateFederalEvidence, mergeContactComplianceEvidence } from '../domain/compliance/contactCompliance';
import { accountInstantSchema } from '../../shared/contracts/accountContract';
import { accountRoutePolicySchema, routePolicyReceiptSchema, type RoutePolicyReceipt } from '../../shared/contracts/accountRoutePolicyContract';
import { accountRoutePolicyImportArtifactSchema, POLICY_IMPORT_MAX_BYTES, policyImportConfirmSchema, policyImportPreviewSchema, policyImportReportSchema, policyImportResumeSchema, policyImportStatusSchema,
  type AccountRoutePolicyImportArtifact, type PolicyImportConfirm, type PolicyImportPreview, type PolicyImportReport, type PolicyImportResume, type PolicyImportRow, type PolicyImportStatus } from '../../shared/contracts/accountRoutePolicyImportContract';
import { AccountRoutePolicyStore } from './accountRoutePolicyStore';

export interface AccountRoutePolicyImportDependencies {
  workspaceId: string;
  clock: Clock;
  databaseGate: { withDatabase<T>(run: (database: AppDatabase, signal: AbortSignal) => T | Promise<T>): Promise<T> };
  native: {
    selectArtifact(maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
    confirmReview(input: { preview: PolicyImportPreview; reviewReason: string }, signal: AbortSignal): Promise<boolean>;
  };
}
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const planSchema = z.strictObject({ rowId: z.string().min(1).max(200), rowHash: hashSchema, expectedPreviousRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expectedPreviousHash: hashSchema.nullable(), receiptHash: hashSchema, receipt: routePolicyReceiptSchema });
type Plan = z.infer<typeof planSchema>;
type Review = { id: string; artifactHash: string; bytes: Buffer; artifact: AccountRoutePolicyImportArtifact; plans: Plan[]; reviewedAt: string };
type Preview = Review & { public: PolicyImportPreview };
type Policy = z.infer<typeof accountRoutePolicySchema>;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const unknownEvidence = (): Policy['contact']['evidence'] => ({ federalStatus: 'unknown', tcpaFlag: null, coveredAreaCode: null, source: 'manual_import', scrubbedAt: null, expiresAt: null });
function evidenceValue(value: Policy['contact']['evidence']): ContactComplianceEvidence {
  return { federalStatus: value.federalStatus, source: value.source, tcpaFlag: value.tcpaFlag ?? null, coveredAreaCode: value.coveredAreaCode ?? null, scrubbedAt: value.scrubbedAt ?? null, expiresAt: value.expiresAt ?? null };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
class Held extends Error {}
function requireCondition(value: unknown, reason: string): asserts value { if (!value) throw new Held(reason); }
function parseArtifact(bytes: Buffer, workspaceId: string): AccountRoutePolicyImportArtifact {
  requireCondition(bytes.length > 0 && bytes.length <= POLICY_IMPORT_MAX_BYTES, 'artifact_size_invalid');
  const artifact = accountRoutePolicyImportArtifactSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  requireCondition(artifact.workspaceId === workspaceId, 'workspace_mismatch');
  for (const doc of artifact.documents) requireCondition(digest(doc.content) === doc.sha256, 'document_hash_mismatch');
  return artifact;
}
function currentReceipt(database: AppDatabase, id: string): { receipt: RoutePolicyReceipt; hash: string } | null {
  const row = database.raw.prepare('SELECT * FROM pm_account_route_policy_receipts WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const evidence = database.raw.prepare('SELECT source_id FROM pm_account_route_policy_evidence WHERE receipt_id=? ORDER BY rowid').all(id) as { source_id: string }[];
  const receipt = routePolicyReceiptSchema.parse({ id: row.id, accountId: row.account_id, routeId: row.route_id, routeVersion: row.route_version,
    canonicalTarget: row.canonical_target, evidenceFingerprint: row.evidence_fingerprint, revision: row.revision, evidenceRef: row.evidence_ref,
    evidenceIds: evidence.map(item => item.source_id), provenance: row.provenance, observedAt: row.observed_at, effectiveAt: row.effective_at, expiresAt: row.expires_at, policy: JSON.parse(String(row.policy_json)) });
  requireCondition(accountFingerprint(receipt) === row.receipt_fingerprint, 'stored_receipt_fingerprint_mismatch');
  return { receipt, hash: String(row.receipt_fingerprint) };
}
function predecessor(database: AppDatabase, row: PolicyImportRow) {
  const found = database.raw.prepare('SELECT id FROM pm_account_route_policy_receipts WHERE account_id=? AND route_id=? AND route_version=? ORDER BY revision DESC LIMIT 1').get(row.accountId, row.routeId, row.expectedRouteVersion) as { id: string } | undefined;
  return found ? currentReceipt(database, found.id) : null;
}
function checkContext(database: AppDatabase, workspaceId: string, row: PolicyImportRow, now: string) {
  const owner = database.raw.prepare('SELECT workspace_id FROM delegated_authorities WHERE account_id=?').get(row.accountId) as { workspace_id: string } | undefined;
  requireCondition(!owner || owner.workspace_id === workspaceId, 'workspace_mismatch');
  const snapshot = new AccountRepository({ database, clock: { now: () => now }, ids: { next: randomUUID } }).snapshot(row.accountId, now);
  requireCondition(snapshot.fingerprint === row.expectedEvidenceFingerprint, 'stale_account_evidence');
  const route = snapshot.routes.find(route => route.id === row.routeId);
  requireCondition(route && route.version === row.expectedRouteVersion && route.channel === 'phone' && route.value === row.policy.contact.normalizedValue, 'stale_route');
  requireCondition(row.targetSourceIds.every(id => route.evidenceIds.includes(id)), 'target_evidence_mismatch');
  requireCondition(row.observedAt <= now && row.effectiveAt <= now && row.expiresAt > now && row.expiresAt > row.effectiveAt, 'policy_time_invalid');
}
/** Documentary review never infers compliance from publication. Uncited facts stay unknown.
 * Ordinary intake uses the existing federal merge. Only explicit documented correction can
 * replace retained restrictions, with the same usable-clear gate as contact correction. */
function reviewedPolicy(row: PolicyImportRow, prior: Policy | undefined, now: string): Policy {
  const policy = structuredClone(row.policy);
  const cited = (field: PolicyImportRow['citations'][number]['field']) => row.citations.some(citation => citation.field === field);
  if (!cited('contact.evidence')) policy.contact.evidence = unknownEvidence();
  if (!cited('contact.validationState')) policy.contact.validationState = 'unverified';
  if (!cited('jurisdiction')) policy.jurisdiction = null;
  if (!cited('clearance')) policy.clearance = null;
  if (row.operation === 'authoritative_correction') {
    requireCondition(cited('contact.evidence') && evaluateFederalEvidence({ normalizedPhone: policy.contact.normalizedValue, evidence: evidenceValue(policy.contact.evidence), now }).kind === 'usable_clear', 'correction_requires_usable_clear');
    // A correction of federal evidence is not an implicit correction of any other restriction.
    requireCondition(!prior || prior.contact.validationState !== 'invalid' || policy.contact.validationState === 'invalid' || cited('contact.validationState'), 'correction_document_required');
    requireCondition(!prior?.clearance || accountFingerprint(prior.clearance) === accountFingerprint(policy.clearance) || cited('clearance'), 'correction_document_required');
    requireCondition(!prior?.jurisdiction || accountFingerprint(prior.jurisdiction) === accountFingerprint(policy.jurisdiction) || cited('jurisdiction'), 'correction_document_required');
  } else {
    policy.contact.evidence = { ...mergeContactComplianceEvidence({ current: evidenceValue(prior?.contact.evidence ?? unknownEvidence()), incoming: evidenceValue(policy.contact.evidence), normalizedPhone: policy.contact.normalizedValue, now }).evidence };
    if (prior?.contact.validationState === 'invalid') policy.contact.validationState = 'invalid';
    if (prior?.clearance && (prior.clearance.decision === 'blocked' || prior.clearance.registrationConfirmed === false || prior.clearance.stateDncSubscriptionConfirmed === false || prior.clearance.consentRuleConfirmed === false)) policy.clearance = structuredClone(prior.clearance);
    // Existing jurisdiction cannot be silently changed to evade its restrictions.
    if (prior?.jurisdiction) policy.jurisdiction = structuredClone(prior.jurisdiction);
  }
  return accountRoutePolicySchema.parse(policy);
}

/** Main-only owner-review capability. No renderer artifact/path or caller authority flags.
 * Review persistence and each actual store admission are separate transactions. */
export function createAccountRoutePolicyImport(deps: AccountRoutePolicyImportDependencies) {
  const workspaceId = z.uuid().parse(deps.workspaceId);
  const previews = new Map<string, Preview>();
  const now = () => accountInstantSchema.parse(deps.clock.now());
  function load(database: AppDatabase, reviewId: string): Review {
    const row = database.raw.prepare('SELECT * FROM account_route_policy_import_reviews WHERE id=? AND workspace_id=?').get(reviewId, workspaceId) as {
      id: string; artifact_sha256: string; artifact_bytes: Buffer; row_plans_json: string; row_count: number; reviewed_at: string; reviewer_kind: string; review_policy_version: string;
    } | undefined;
    requireCondition(row, 'review_not_found');
    requireCondition(row.reviewer_kind === 'local_owner_review' && row.review_policy_version === 'account_route_policy_import_review_v1', 'review_provenance_invalid');
    const bytes = Buffer.from(row.artifact_bytes); requireCondition(digest(bytes) === row.artifact_sha256, 'artifact_hash_mismatch');
    const artifact = parseArtifact(bytes, workspaceId);
    const plans = z.array(planSchema).min(1).max(100).parse(JSON.parse(row.row_plans_json));
    requireCondition(plans.length === row.row_count && plans.length === artifact.rows.length, 'review_rows_invalid');
    for (const [index, plan] of plans.entries()) {
      const input = artifact.rows[index]; const receipt = plan.receipt;
      requireCondition(plan.rowId === input.rowId && plan.rowHash === accountFingerprint(input) && plan.receiptHash === accountFingerprint(receipt)
        && receipt.provenance === row.id && receipt.accountId === input.accountId && receipt.routeId === input.routeId && receipt.routeVersion === input.expectedRouteVersion
        && receipt.canonicalTarget === input.policy.contact.normalizedValue && receipt.evidenceFingerprint === input.expectedEvidenceFingerprint
        && accountFingerprint(receipt.evidenceIds) === accountFingerprint(input.targetSourceIds) && receipt.evidenceRef === input.targetSourceIds[0]
        && receipt.revision === plan.expectedPreviousRevision + 1 && ((plan.expectedPreviousRevision === 0) === (plan.expectedPreviousHash === null)), 'review_plan_invalid');
    }
    return { id: row.id, artifactHash: row.artifact_sha256, bytes, artifact, plans, reviewedAt: accountInstantSchema.parse(row.reviewed_at) };
  }
  function checkPlan(database: AppDatabase, review: Review, plan: Plan, signal: AbortSignal) {
    const actual = currentReceipt(database, plan.receipt.id);
    if (actual) { requireCondition(actual.hash === plan.receiptHash, 'receipt_identity_conflict'); return true; }
    signal.throwIfAborted();
    const row = review.artifact.rows.find(row => row.rowId === plan.rowId)!;
    checkContext(database, workspaceId, row, now());
    const previous = predecessor(database, row);
    requireCondition((previous?.receipt.revision ?? 0) === plan.expectedPreviousRevision && (previous?.hash ?? null) === plan.expectedPreviousHash, 'stale_policy_predecessor');
    if (row.operation === 'authoritative_correction') requireCondition(evaluateFederalEvidence({ normalizedPhone: plan.receipt.canonicalTarget, evidence: evidenceValue(plan.receipt.policy.contact.evidence), now: now() }).kind === 'usable_clear', 'correction_requires_usable_clear');
    return false;
  }
  function report(database: AppDatabase, review: Review, signal: AbortSignal): PolicyImportReport {
    return policyImportReportSchema.parse({ reviewId: review.id, artifactHash: review.artifactHash, reviewedAt: review.reviewedAt, rows: review.plans.map(plan => {
      try {
        const admitted = checkPlan(database, review, plan, signal);
        return { rowId: plan.rowId, receiptId: plan.receipt.id, status: admitted ? 'admitted' : 'pending', reason: null as string | null, receiptFingerprint: admitted ? plan.receiptHash : null };
      } catch (error) { return { rowId: plan.rowId, receiptId: plan.receipt.id, status: 'held', reason: error instanceof Held ? error.message : 'review_context_unavailable', receiptFingerprint: null }; }
    }) });
  }
  function admit(database: AppDatabase, review: Review, signal: AbortSignal): PolicyImportReport {
    const failures = new Set<string>();
    for (const plan of review.plans) {
      if (signal.aborted) break;
      try {
        new AccountRoutePolicyStore({ database, clock: deps.clock, admission: { attest: receipt => {
          signal.throwIfAborted();
          const persisted = load(database, review.id);
          const actualPlan = persisted.plans.find(item => item.rowId === plan.rowId);
          requireCondition(actualPlan && actualPlan.receiptHash === accountFingerprint(receipt) && actualPlan.receiptHash === plan.receiptHash, 'unreviewed_receipt');
          checkPlan(database, persisted, actualPlan, signal);
          return true;
        } } }).admit(plan.receipt);
      } catch { failures.add(plan.rowId); }
    }
    const result = report(database, review, signal);
    for (const row of result.rows) if (row.status === 'pending' && failures.has(row.rowId)) row.reason = 'receipt_not_saved';
    return result;
  }
  return {
    async selectAndPreview(): Promise<PolicyImportPreview | null> {
      return deps.databaseGate.withDatabase(async (database, signal) => {
        signal.throwIfAborted(); const selected = await deps.native.selectArtifact(POLICY_IMPORT_MAX_BYTES, signal); signal.throwIfAborted();
        if (selected === null) return null;
        const bytes = Buffer.from(selected); const artifact = parseArtifact(bytes, workspaceId); const artifactHash = digest(bytes);
        const existing = database.raw.prepare('SELECT id FROM account_route_policy_import_reviews WHERE workspace_id=? AND artifact_sha256=?').get(workspaceId, artifactHash) as { id: string } | undefined;
        const id = existing?.id ?? randomUUID();
        const review: Review = existing ? load(database, id) : database.raw.transaction(() => ({ id, artifactHash, artifact, bytes, reviewedAt: now(), plans: artifact.rows.map(row => {
          checkContext(database, workspaceId, row, now()); const previous = predecessor(database, row);
          const receipt = routePolicyReceiptSchema.parse({ id: randomUUID(), accountId: row.accountId, routeId: row.routeId, routeVersion: row.expectedRouteVersion, canonicalTarget: row.policy.contact.normalizedValue,
            evidenceFingerprint: row.expectedEvidenceFingerprint, revision: (previous?.receipt.revision ?? 0) + 1, evidenceRef: row.targetSourceIds[0], evidenceIds: row.targetSourceIds,
            provenance: id, observedAt: row.observedAt, effectiveAt: row.effectiveAt, expiresAt: row.expiresAt, policy: reviewedPolicy(row, previous?.receipt.policy, now()) });
          return { rowId: row.rowId, rowHash: accountFingerprint(row), expectedPreviousRevision: previous?.receipt.revision ?? 0, expectedPreviousHash: previous?.hash ?? null, receiptHash: accountFingerprint(receipt), receipt };
        }) })).deferred();
        const previewId = randomUUID();
        const value = freeze(policyImportPreviewSchema.parse({ previewId, artifactHash, reviewId: id, artifact: review.artifact,
          rows: review.plans.map(plan => ({ rowId: plan.rowId, receiptId: plan.receipt.id, policy: plan.receipt.policy, heldReason: null as string | null })),
          notice: 'Owner-reviewed FSS evidence interchange. Not government or vendor verification, legal clearance, or permission to call.' }));
        // Bounded session-only previews. Bytes and pinned plans never escape this closure.
        if (previews.size >= 8) previews.delete(previews.keys().next().value!);
        previews.set(previewId, { ...review, public: value }); return value;
      });
    },
    async confirm(input: PolicyImportConfirm): Promise<PolicyImportReport> {
      const request = policyImportConfirmSchema.parse(input);
      const preview = previews.get(request.previewId);
      requireCondition(preview && preview.artifactHash === request.expectedArtifactHash, 'preview_identity_mismatch');
      return deps.databaseGate.withDatabase(async (database, signal) => {
        signal.throwIfAborted();
        const confirmed = await deps.native.confirmReview(freeze({ preview: preview.public, reviewReason: request.reviewReason }), signal);
        signal.throwIfAborted(); requireCondition(confirmed === true, 'review_cancelled');
        const id = database.raw.transaction(() => {
          const existing = database.raw.prepare('SELECT id FROM account_route_policy_import_reviews WHERE workspace_id=? AND artifact_sha256=?').get(workspaceId, preview.artifactHash) as { id: string } | undefined;
          if (existing) return existing.id;
          database.raw.prepare('INSERT INTO account_route_policy_import_reviews(id,workspace_id,artifact_sha256,artifact_bytes,row_plans_json,row_count,review_reason,reviewed_at,reviewer_kind,review_policy_version) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(preview.id, workspaceId, preview.artifactHash, preview.bytes, JSON.stringify(preview.plans), preview.plans.length, request.reviewReason, now(), 'local_owner_review', 'account_route_policy_import_review_v1');
          return preview.id;
        }).immediate();
        previews.delete(request.previewId);
        return admit(database, load(database, id), signal);
      });
    },
    async resume(input: PolicyImportResume): Promise<PolicyImportReport> {
      const request = policyImportResumeSchema.parse(input);
      return deps.databaseGate.withDatabase((database, signal) => { signal.throwIfAborted(); const review = load(database, request.reviewId); requireCondition(review.artifactHash === request.expectedArtifactHash, 'artifact_hash_mismatch'); return admit(database, review, signal); });
    },
    async status(input: PolicyImportStatus): Promise<PolicyImportReport> {
      const request = policyImportStatusSchema.parse(input);
      return deps.databaseGate.withDatabase((database, signal) => { signal.throwIfAborted(); return database.raw.transaction(() => report(database, load(database, request.reviewId), signal)).deferred(); });
    },
  };
}
