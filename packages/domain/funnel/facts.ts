import type { RepositoryContext } from '../db/workspaceScope.ts';
import { actorKind, actorUserId } from '../crm/types.ts';
import {
  FUNNEL_DEDUPE_KEY_SHAPE,
  FUNNEL_DETAIL_VALUE_SHAPE,
  FUNNEL_KEY_SHAPE,
  FUNNEL_KIND_SHAPE,
  FUNNEL_SOURCE_SHAPE,
} from './kinds.ts';

/**
 * The one way a fact is written (migration 0022, `docs/greenfield/funnel.md`).
 *
 * Three properties, and each of them is why this is a function rather than an
 * `INSERT` at a call site:
 *
 *   * **Committed or absent.** It runs inside whatever transaction the caller
 *     holds and opens none of its own, so a fact exists exactly when the business
 *     change that caused it does. A rolled-back command leaves no count behind.
 *   * **Deduplicated by the database.** `ON CONFLICT ON CONSTRAINT
 *     funnel_facts_dedupe DO NOTHING` — a replayed command or a re-run handler
 *     produces one fact, and the second call answers `duplicate` rather than
 *     throwing. A unique violation would abort the transaction it was replaying
 *     inside, which is the bug this shape exists to prevent.
 *   * **Refused before the insert.** A kind, a source, a key, a subject or a
 *     `detail` that is wrong is a refusal this function makes, not a constraint
 *     crash. The reason is the same either way; the difference is that the caller's
 *     transaction survives it and can decide what to do.
 *
 * Two of those refusals are worth their own sentence.
 *
 * **`invalid_subject`: a contact and an opportunity together.** `crm/merges.ts`
 * moves contacts before opportunities, so a fact naming both would have its
 * `firm_id` cascaded to the target by the contact triple while its opportunity
 * triple still pointed at the source firm, and the opportunity key would fail
 * *inside* the merge. `funnel_facts_one_child` refuses it in the database; this
 * refuses it before the statement, so a caller gets a reason rather than a merge
 * that cannot run later.
 *
 * **`invalid_detail`: no free text, ever.** `detail` is a flat object of ids, codes,
 * numbers, booleans and nulls — no nesting, no arrays, at most 32 keys, and a string
 * must look like an identifier. A firm-less fact has no firm for the deletion
 * workflow to find it by, so a `detail` that could hold a name would be a name with
 * no deletion path. The database bounds the column; this is what keeps it a count.
 *
 * The actor comes from the context exactly as `emitCrmDomainEvent` takes it, so a
 * fact says who caused it in the vocabulary the audit trail already uses.
 */

export interface FunnelFactInput {
  /** A dotted lower-case kind. The v1 dictionary is in `kinds.ts`; the list is open. */
  readonly kind: string;
  /** The module writing it: `crm`, `research`, `telephony`, `calendar`, `demo`, … */
  readonly source: string;
  /** The ids that identify the thing, never a timestamp. One fact per (kind, key). */
  readonly dedupeKey: string;
  readonly firmId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly opportunityId?: string | undefined;
  /** An instant the emitter knows better than `now()`: a reconciled provider record. */
  readonly occurredAt?: string | undefined;
  /** Flags and codes. Never a name, an address, a number or a body. */
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

export type FunnelFactRefusal =
  | 'duplicate'
  | 'invalid_kind'
  | 'invalid_source'
  | 'invalid_key'
  | 'invalid_subject'
  | 'invalid_detail';

export type FunnelFactOutcome =
  | { readonly recorded: true; readonly id: string }
  | { readonly recorded: false; readonly reason: FunnelFactRefusal };

/** At most this many keys in `detail`. A fact is a count, not a document. */
const MAX_DETAIL_KEYS = 32;

/**
 * A flat object of ids, codes, numbers, booleans and nulls, and nothing else.
 *
 * `Object.entries` rather than a schema: the rule is small enough to read, and what
 * it refuses — an array, a nested object, a sentence — is exactly what a reader of
 * this file needs to see without following an import.
 */
function detailIsFlatAndCoded(detail: Readonly<Record<string, unknown>>): boolean {
  if (typeof detail !== 'object' || Array.isArray(detail)) return false;
  const entries = Object.entries(detail);
  if (entries.length > MAX_DETAIL_KEYS) return false;
  for (const [key, value] of entries) {
    if (!FUNNEL_KEY_SHAPE.test(key)) return false;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value === 'string') {
      if (!FUNNEL_DETAIL_VALUE_SHAPE.test(value)) return false;
      continue;
    }
    return false;
  }
  return true;
}

export async function recordFunnelFact(
  context: RepositoryContext,
  input: FunnelFactInput,
): Promise<FunnelFactOutcome> {
  if (!FUNNEL_KIND_SHAPE.test(input.kind) || input.kind.length > 64) {
    return { recorded: false, reason: 'invalid_kind' };
  }
  if (!FUNNEL_SOURCE_SHAPE.test(input.source) || input.source.length > 32) {
    return { recorded: false, reason: 'invalid_source' };
  }
  if (!FUNNEL_DEDUPE_KEY_SHAPE.test(input.dedupeKey)) {
    return { recorded: false, reason: 'invalid_key' };
  }
  if (input.contactId !== undefined && input.opportunityId !== undefined) {
    return { recorded: false, reason: 'invalid_subject' };
  }
  const detail = input.detail ?? {};
  if (!detailIsFlatAndCoded(detail)) {
    return { recorded: false, reason: 'invalid_detail' };
  }

  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO funnel_facts
       (workspace_id, kind, firm_id, contact_id, opportunity_id, dedupe_key, source,
        actor_kind, actor_user_id, detail, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, COALESCE($11::timestamptz, now()))
     ON CONFLICT ON CONSTRAINT funnel_facts_dedupe DO NOTHING
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.kind,
      input.firmId ?? null,
      input.contactId ?? null,
      input.opportunityId ?? null,
      input.dedupeKey,
      input.source,
      actorKind(context),
      actorUserId(context),
      JSON.stringify(detail),
      input.occurredAt ?? null,
    ],
  );

  const id = rows[0]?.id;
  if (id === undefined) return { recorded: false, reason: 'duplicate' };
  return { recorded: true, id };
}
