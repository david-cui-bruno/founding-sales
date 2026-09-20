import type { QueryResultRowLike } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmMutation } from './authorization.ts';
import { loadFirmForUpdate } from './firms.ts';
import { accept, refuse, type CrmResult } from './types.ts';

/**
 * Evidence items (specification 7.2, 7.4, 10.3).
 *
 * "Any confidence level may be retained as evidence when provider terms allow." So
 * nothing here gates on confidence: a low-confidence fact is still evidence, and the
 * gate lives on the *route* it might justify, in `routePolicy.ts`. That separation is
 * the point of section 7.4 — research may collect freely and may not promote.
 *
 * Uniqueness is `(workspace, firm, provider, content hash)`, which is Appendix C's
 * "provider result/evidence uniqueness": a research job replayed after a crash
 * records the same page once.
 */

export interface EvidenceRow extends QueryResultRowLike {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly provider: string;
  readonly source_reference: string;
  readonly content_hash: string;
}

export interface RecordEvidenceInput {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly provider: string;
  readonly sourceReference: string;
  readonly contentHash: string;
  readonly retrievedAt?: Date | undefined;
  readonly confidence?: number | undefined;
  readonly termsAllowRetention?: boolean | undefined;
  readonly retentionExpiresAt?: Date | undefined;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Record one piece of evidence. Idempotent on the provider's own content hash, so a
 * replayed research page produces one row and returns it rather than failing.
 */
export async function recordEvidence(
  context: RepositoryContext,
  input: RecordEvidenceInput,
): Promise<CrmResult<EvidenceRow>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);

  const { rows } = await context.db.query<EvidenceRow>(
    `INSERT INTO evidence_items
       (workspace_id, firm_id, contact_id, provider, source_reference, retrieved_at,
        confidence, terms_allow_retention, retention_expires_at, content_hash, detail)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7, COALESCE($8, true), $9, $10, $11::jsonb)
     ON CONFLICT ON CONSTRAINT evidence_items_one_per_result DO NOTHING
     RETURNING id, firm_id, contact_id, provider, source_reference, content_hash`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.contactId ?? null,
      input.provider,
      input.sourceReference,
      input.retrievedAt ?? null,
      input.confidence ?? null,
      input.termsAllowRetention ?? null,
      input.retentionExpiresAt ?? null,
      input.contentHash,
      JSON.stringify(input.detail ?? {}),
    ],
  );
  const created = rows[0];
  if (created !== undefined) return accept(created);

  const existing = await context.db.query<EvidenceRow>(
    `SELECT id, firm_id, contact_id, provider, source_reference, content_hash
       FROM evidence_items
      WHERE workspace_id = $1 AND firm_id = $2 AND provider = $3 AND content_hash = $4`,
    [context.scope.workspaceId, input.firmId, input.provider, input.contentHash],
  );
  const row = existing.rows[0];
  return row === undefined ? refuse('evidence_unknown') : accept(row);
}

export async function listEvidence(
  context: RepositoryContext,
  firmId: string,
  limit = 50,
): Promise<readonly EvidenceRow[]> {
  const { rows } = await context.db.query<EvidenceRow>(
    `SELECT id, firm_id, contact_id, provider, source_reference, content_hash
       FROM evidence_items
      WHERE workspace_id = $1 AND firm_id = $2
      ORDER BY retrieved_at DESC
      LIMIT $3`,
    [context.scope.workspaceId, firmId, Math.trunc(limit)],
  );
  return rows;
}
