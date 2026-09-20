import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { canonicalFirmOf } from '../crm/merges.ts';
import {
  accept,
  isFillableCanonicalField,
  numeric,
  refuse,
  type FillableCanonicalField,
  type ResearchResult,
  type ResearchSuggestionKind,
  type ResearchSuggestionRow,
  type ResearchSuggestionState,
} from './types.ts';

/**
 * Suggestions: what research believes, recorded where a person can see it
 * (specification 7.4; deliverables 1 and 4).
 *
 * Section 7.4 draws one line and this file is on both sides of it:
 *
 * > High-confidence non-contact facts may populate empty canonical fields.
 * > Lower-confidence or conflicting facts remain visible suggestions and never
 * > overwrite confirmed values.
 *
 * So there are exactly two outcomes for a finding, decided by `decideSuggestionEffect`
 * and by nothing else:
 *
 *   * **applied** — a canonical field in `FILLABLE_CANONICAL_FIELDS`, currently empty,
 *     from a non-contact fact at or above `AUTOMATIC_FILL_CONFIDENCE`. The field is
 *     written and the suggestion is recorded as `applied`, so the provenance of a
 *     value nobody typed is always readable.
 *   * **proposed** — everything else. A contact, a route, a duplicate, a low-confidence
 *     fact, or a fact that disagrees with a value already there.
 *
 * Three things make "never overwrite" true rather than intended:
 *
 *   1. `FILLABLE_CANONICAL_FIELDS` contains no field a contact route, a note or a
 *      message could occupy, so the automatic path cannot reach one;
 *   2. the fill is `UPDATE ... WHERE <column> IS NULL`, so a value that arrived between
 *      the read and the write is not overwritten — the update affects no row and the
 *      suggestion stays `proposed`;
 *   3. migration 0005's `research_suggestions_only_facts_apply` refuses an `applied`
 *      row of any other kind, so a future caller that tries cannot even record it.
 *
 * ## Suggestions and merges
 *
 * `mergeFirms` re-points the children G3a knows about; it does not know about this
 * table, and this lane does not edit `merges.ts`. So a suggestion written against a
 * firm that is later merged stays on the source row — which is exactly what
 * `docs/decisions/g3a-merge-preservation.md` does with everything it cannot move:
 * nothing is deleted, the source keeps `status = 'merged'` and a pointer, and its
 * children remain readable.
 *
 * The *reads* follow the pointer instead. `listSuggestions` returns a merged source's
 * suggestions under the canonical firm, and `reviewSuggestion` authorizes against the
 * canonical firm and writes its field. So a merge loses no suggestion and leaves none
 * unreviewable, without rewriting history. Recorded in
 * `docs/decisions/g10-suggestions-follow-merges.md`.
 */

/**
 * The confidence a non-contact fact needs to fill an empty canonical field.
 *
 * 0.9, deliberately above the 0.8 a route needs to become `usable`. A route's
 * threshold governs whether a person may be contacted through it, which is checked
 * again at the point of contact by `authorizeDial` and the send path; a canonical
 * field written with no review is checked again by nobody until someone notices it is
 * wrong. The stricter number belongs to the unreviewed path.
 *
 * Recorded in `docs/decisions/g10-automatic-fill-threshold.md`.
 */
export const AUTOMATIC_FILL_CONFIDENCE = 0.9;

export interface SuggestionFinding {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly kind: ResearchSuggestionKind;
  /** Required for `canonical_field`, forbidden otherwise (the database agrees). */
  readonly fieldKey?: string | undefined;
  readonly proposedValue: string;
  readonly confidence?: number | undefined;
  readonly providerKey: string;
  readonly evidenceId?: string | undefined;
  readonly duplicateFirmId?: string | undefined;
  /** One suggestion per (firm, kind, key). Built from what identifies the finding. */
  readonly dedupeKey: string;
}

export interface RecordedSuggestion {
  readonly id: string;
  readonly kind: ResearchSuggestionKind;
  readonly state: ResearchSuggestionState;
  readonly fieldKey: string | null;
  readonly proposedValue: string;
  /** True when this call wrote the canonical field as well as the suggestion. */
  readonly applied: boolean;
}

const SUGGESTION_COLUMNS = `id, firm_id, contact_id, kind, field_key, proposed_value, confidence,
  provider_key, evidence_id, duplicate_firm_id, dedupe_key, state`;

export type SuggestionEffect =
  | { readonly effect: 'fill'; readonly field: FillableCanonicalField }
  | { readonly effect: 'propose'; readonly reason: 'not_a_fillable_field' | 'confidence_below_threshold' | 'value_present' | 'not_a_fact' };

/**
 * Whether a finding may fill a canonical field, or must wait for a person.
 *
 * Pure, and the one place the rule lives. `existingValue` is what the firm row already
 * holds: a present value means the finding is at best a *conflicting* fact, which
 * section 7.4 keeps as a visible suggestion.
 */
export function decideSuggestionEffect(input: {
  readonly kind: ResearchSuggestionKind;
  readonly fieldKey: string | undefined;
  readonly confidence: number | undefined;
  readonly existingValue: string | null;
}): SuggestionEffect {
  if (input.kind !== 'canonical_field') return { effect: 'propose', reason: 'not_a_fact' };
  const field = input.fieldKey;
  if (field === undefined || !isFillableCanonicalField(field)) {
    return { effect: 'propose', reason: 'not_a_fillable_field' };
  }
  if (input.existingValue !== null && input.existingValue.trim() !== '') {
    return { effect: 'propose', reason: 'value_present' };
  }
  const confidence = input.confidence;
  if (confidence === undefined || !Number.isFinite(confidence) || confidence < AUTOMATIC_FILL_CONFIDENCE) {
    return { effect: 'propose', reason: 'confidence_below_threshold' };
  }
  return { effect: 'fill', field };
}

/**
 * Record one finding, filling the canonical field when section 7.4 allows it.
 *
 * Idempotent on `(firm, kind, dedupe_key)`: a replayed enrichment run records the same
 * finding once and returns the row that is already there, so a job that is retried
 * does not multiply a person's review queue.
 */
export async function recordSuggestion(
  context: RepositoryContext,
  finding: SuggestionFinding,
): Promise<ResearchResult<RecordedSuggestion>> {
  const firm = await loadFirmForUpdate(context, finding.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason === 'firm_merged' ? 'firm_merged' : 'not_assigned');
  if (finding.proposedValue.trim() === '') return refuse('invalid_input');

  const existingValue =
    finding.kind === 'canonical_field' && finding.fieldKey !== undefined && isFillableCanonicalField(finding.fieldKey)
      ? readFirmField(firm, finding.fieldKey)
      : null;
  const effect = decideSuggestionEffect({
    kind: finding.kind,
    fieldKey: finding.fieldKey,
    confidence: finding.confidence,
    existingValue,
  });

  let applied = false;
  if (effect.effect === 'fill') {
    // `WHERE <column> IS NULL` is the guarantee, not the read above: a value written
    // between the two leaves this update affecting nothing, and the suggestion stays
    // proposed for a person to compare.
    const { rowCount } = await context.db.query(
      `UPDATE firms SET ${effect.field} = $3, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND ${effect.field} IS NULL`,
      [context.scope.workspaceId, finding.firmId, finding.proposedValue.trim()],
    );
    applied = (rowCount ?? 0) === 1;
  }

  const state: ResearchSuggestionState = applied ? 'applied' : 'proposed';
  const { rows } = await context.db.query<ResearchSuggestionRow>(
    `INSERT INTO research_suggestions
       (workspace_id, firm_id, contact_id, kind, field_key, proposed_value, confidence,
        provider_key, evidence_id, duplicate_firm_id, dedupe_key, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT ON CONSTRAINT research_suggestions_one_per_finding DO NOTHING
     RETURNING ${SUGGESTION_COLUMNS}`,
    [
      context.scope.workspaceId,
      finding.firmId,
      finding.contactId ?? null,
      finding.kind,
      finding.fieldKey ?? null,
      finding.proposedValue.trim(),
      finding.confidence ?? null,
      finding.providerKey,
      finding.evidenceId ?? null,
      finding.duplicateFirmId ?? null,
      finding.dedupeKey,
      state,
    ],
  );

  const created = rows[0];
  if (created !== undefined) {
    if (applied) {
      await recordCrmAuditEvent(context, {
        action: 'research.canonical_field_filled',
        subjectKind: 'firm',
        subjectId: finding.firmId,
        detail: { field: finding.fieldKey, provider: finding.providerKey, suggestionId: created.id },
      });
    }
    return accept({
      id: created.id,
      kind: created.kind,
      state: created.state,
      fieldKey: created.field_key,
      proposedValue: created.proposed_value,
      applied,
    });
  }

  const existing = await readSuggestionByFinding(context, finding);
  if (existing === null) return refuse('invalid_input');
  return accept({
    id: existing.id,
    kind: existing.kind,
    state: existing.state,
    fieldKey: existing.field_key,
    proposedValue: existing.proposed_value,
    applied: false,
  });
}

async function readSuggestionByFinding(
  context: RepositoryContext,
  finding: SuggestionFinding,
): Promise<ResearchSuggestionRow | null> {
  const { rows } = await context.db.query<ResearchSuggestionRow>(
    `SELECT ${SUGGESTION_COLUMNS} FROM research_suggestions
      WHERE workspace_id = $1 AND firm_id = $2 AND kind = $3 AND dedupe_key = $4`,
    [context.scope.workspaceId, finding.firmId, finding.kind, finding.dedupeKey],
  );
  return rows[0] ?? null;
}

function readFirmField(firm: Readonly<Record<string, unknown>>, field: FillableCanonicalField): string | null {
  const value = firm[field];
  return typeof value === 'string' ? value : null;
}

export interface SuggestionSummary {
  readonly id: string;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly kind: ResearchSuggestionKind;
  readonly fieldKey: string | null;
  readonly proposedValue: string;
  readonly confidence: number | null;
  readonly providerKey: string;
  readonly evidenceId: string | null;
  readonly duplicateFirmId: string | null;
  readonly state: ResearchSuggestionState;
}

function toSummary(row: ResearchSuggestionRow): SuggestionSummary {
  return {
    id: row.id,
    firmId: row.firm_id,
    contactId: row.contact_id,
    kind: row.kind,
    fieldKey: row.field_key,
    proposedValue: row.proposed_value,
    confidence: numeric(row.confidence),
    providerKey: row.provider_key,
    evidenceId: row.evidence_id,
    duplicateFirmId: row.duplicate_firm_id,
    state: row.state,
  };
}

/**
 * The suggestions a person may review.
 *
 * A salesperson sees their assigned firms' suggestions; an admin sees every one. The
 * filter is in the statement rather than applied afterwards, so a page of results is
 * a page the caller may see rather than a page with rows removed.
 */
export async function listSuggestions(
  context: RepositoryContext,
  options: {
    readonly firmId?: string | undefined;
    readonly state?: ResearchSuggestionState | undefined;
    readonly limit?: number | undefined;
  } = {},
): Promise<readonly SuggestionSummary[]> {
  const actor = context.scope.actor;
  const restrictToAssignee = actor.kind === 'user' && actor.role !== 'admin' ? actor.userId : null;
  // `canonical` is the firm a suggestion belongs to *now*: itself, or the firm its own
  // was merged into. One hop, which is the depth a merge of a merged record can reach
  // before `decideFirmMutation` refuses the source as `firm_merged`.
  const { rows } = await context.db.query<ResearchSuggestionRow>(
    `SELECT s.id, s.firm_id, s.contact_id, s.kind, s.field_key, s.proposed_value, s.confidence,
            s.provider_key, s.evidence_id, s.duplicate_firm_id, s.dedupe_key, s.state
       FROM research_suggestions s
       JOIN firms own ON own.workspace_id = s.workspace_id AND own.id = s.firm_id
       JOIN firms canonical
         ON canonical.workspace_id = s.workspace_id
        AND canonical.id = COALESCE(own.merged_into_firm_id, own.id)
      WHERE s.workspace_id = $1
        AND ($2::uuid IS NULL OR canonical.id = $2::uuid)
        AND ($3::text IS NULL OR s.state = $3::text)
        AND ($4::uuid IS NULL OR canonical.assigned_user_id = $4::uuid)
      ORDER BY s.created_at DESC, s.id
      LIMIT $5`,
    [
      context.scope.workspaceId,
      options.firmId ?? null,
      options.state ?? null,
      restrictToAssignee,
      Math.trunc(options.limit ?? 100),
    ],
  );
  return rows.map(toSummary);
}

export interface ReviewSuggestionInput {
  readonly suggestionId: string;
  readonly decision: 'accepted' | 'rejected';
  readonly note?: string | undefined;
}

export interface ReviewOutcome {
  readonly suggestionId: string;
  readonly state: ResearchSuggestionState;
  /** True when accepting also wrote the canonical field. Never true for other kinds. */
  readonly fieldWritten: boolean;
}

/**
 * Accept or reject a suggestion.
 *
 * Accepting a `canonical_field` suggestion writes the field — this is a person's
 * decision, so it may overwrite, and an overwrite is audited with both values. But
 * accepting a `duplicate_firm` suggestion does **not** merge anything: section 7.2
 * says "research may suggest duplicates but never performs a destructive merge
 * automatically", and a merge is `mergeFirms`, an audited command with its own
 * conflict resolution. Accepting the suggestion records that the person agrees it is a
 * duplicate; they then run the merge, which can refuse and ask them about a conflict.
 *
 * Accepting a `contact`, `phone_route` or `email_route` suggestion likewise records
 * agreement. Creating the contact or the route is `createContact` / `addPhoneRoute`,
 * where the route's eligibility is the policy's decision — so an accepted route
 * suggestion still cannot become `usable` on a person's say-so alone.
 */
export async function reviewSuggestion(
  context: RepositoryContext,
  input: ReviewSuggestionInput,
): Promise<ResearchResult<ReviewOutcome>> {
  const { rows: loaded } = await context.db.query<ResearchSuggestionRow>(
    `SELECT ${SUGGESTION_COLUMNS} FROM research_suggestions
      WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, input.suggestionId],
  );
  const suggestion = loaded[0];
  if (suggestion === undefined) return refuse('suggestion_unknown');
  if (suggestion.state !== 'proposed') return refuse('suggestion_already_reviewed');

  // A suggestion on a firm that has since been merged is reviewed against the record
  // it became. Without this, a merge would leave its source's suggestions permanently
  // unreviewable, refused as `firm_merged` by a person who did nothing wrong.
  const canonicalId = (await canonicalFirmOf(context, suggestion.firm_id)) ?? suggestion.firm_id;
  const firm = await loadFirmForUpdate(context, canonicalId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason === 'firm_merged' ? 'firm_merged' : 'not_assigned');

  const reviewer = context.scope.actor.kind === 'user' ? context.scope.actor.userId : null;
  // A system actor cannot review: `research_suggestions_review_consistent` requires a
  // reviewer for an accepted or rejected row, and the whole point of the state is that
  // a person took it. A worker that reached here would be automation reviewing itself.
  if (reviewer === null) return refuse('admin_only');

  let fieldWritten = false;
  if (
    input.decision === 'accepted' &&
    suggestion.kind === 'canonical_field' &&
    suggestion.field_key !== null &&
    isFillableCanonicalField(suggestion.field_key)
  ) {
    const previous = readFirmField(firm, suggestion.field_key);
    const { rowCount } = await context.db.query(
      `UPDATE firms SET ${suggestion.field_key} = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, canonicalId, suggestion.proposed_value],
    );
    fieldWritten = (rowCount ?? 0) === 1;
    if (fieldWritten) {
      await recordCrmAuditEvent(context, {
        action: 'research.suggestion_field_written',
        subjectKind: 'firm',
        subjectId: canonicalId,
        detail: {
          field: suggestion.field_key,
          suggestionId: suggestion.id,
          replacedExistingValue: previous !== null && previous.trim() !== '',
        },
      });
    }
  }

  await context.db.query(
    `UPDATE research_suggestions
        SET state = $3, reviewed_by_user_id = $4, reviewed_at = now(), review_note = $5, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.suggestionId, input.decision, reviewer, input.note ?? null],
  );

  await recordCrmAuditEvent(context, {
    action: `research.suggestion_${input.decision}`,
    subjectKind: 'research_suggestion',
    subjectId: input.suggestionId,
    detail: { firmId: canonicalId, kind: suggestion.kind, fieldWritten },
  });

  return accept({ suggestionId: input.suggestionId, state: input.decision, fieldWritten });
}
