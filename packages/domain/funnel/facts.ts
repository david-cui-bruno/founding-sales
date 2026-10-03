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
 * **`invalid_subject`: a contact and an opportunity together, or a child with no
 * firm.** The second half is the plainer one: `funnel_facts_firm_present_for_child`
 * would refuse it in the database and take the caller's transaction with it.
 *
 * The first half is the interesting one. `crm/merges.ts`
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

/** `funnel_facts_detail_is_object`'s other half: `length(detail::text) <= 4000`. */
const MAX_DETAIL_TEXT = 4000;

type CodedValue = string | number | boolean | null;

/**
 * The validated `detail`, as a plain object and as the exact bytes to insert.
 *
 * Two things here are load-bearing and neither is obvious.
 *
 * **The copy, not the caller's object.** The values are validated one at a time and
 * then put in a fresh object with `Object.fromEntries`, and it is *that* object
 * which is serialized and inserted. A caller's object may inherit a `toJSON` from
 * its prototype — `Object.entries` does not see it, but `JSON.stringify` would call
 * it, and the string written would then be something no rule above ever looked at.
 * The plain copy has `Object.prototype` and no `toJSON`, so what was validated is
 * what is stored. (A `toJSON` as an *own* enumerable property is a function value
 * and is refused outright by the type test below.)
 *
 * **The serialized size, not the key count.** The CHECK bounds
 * `length(detail::text)`, which is what PostgreSQL renders, not what
 * `JSON.stringify` produced: thirty-two 64-character keys with 64-character values
 * pass every per-value rule and serialize past 4 000 characters. That would abort
 * the caller's transaction on a constraint, which is exactly what this function
 * exists to prevent — so the size is checked here too. PostgreSQL renders a space
 * after each colon and each comma, so the bound is the conservative one: two
 * characters per entry more than `JSON.stringify` wrote.
 */
function codedDetail(
  detail: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly json: string } | { readonly ok: false } {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return { ok: false };
  const entries = Object.entries(detail);
  if (entries.length > MAX_DETAIL_KEYS) return { ok: false };

  const validated: [string, CodedValue][] = [];
  for (const [key, value] of entries) {
    if (!FUNNEL_KEY_SHAPE.test(key)) return { ok: false };
    if (value === null || typeof value === 'boolean') {
      validated.push([key, value]);
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { ok: false };
      validated.push([key, value]);
      continue;
    }
    if (typeof value === 'string') {
      if (!FUNNEL_DETAIL_VALUE_SHAPE.test(value)) return { ok: false };
      validated.push([key, value]);
      continue;
    }
    return { ok: false };
  }

  const json = JSON.stringify(Object.fromEntries(validated));
  if (json.length + 2 * validated.length > MAX_DETAIL_TEXT) return { ok: false };
  return { ok: true, json };
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
  // A child with no firm fails `funnel_facts_firm_present_for_child`, which would
  // abort the caller's transaction. Same reason, so the same refusal.
  if (input.firmId === undefined && (input.contactId !== undefined || input.opportunityId !== undefined)) {
    return { recorded: false, reason: 'invalid_subject' };
  }
  const detail = codedDetail(input.detail ?? {});
  if (!detail.ok) {
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
      detail.json,
      input.occurredAt ?? null,
    ],
  );

  const id = rows[0]?.id;
  if (id === undefined) return { recorded: false, reason: 'duplicate' };
  return { recorded: true, id };
}

/** A withdrawal's reason: a lower-case code (`funnel_facts_withdrawn_reason_shape`, 0039). */
export const FUNNEL_WITHDRAWN_REASON_SHAPE = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Withdraw facts that turned out to be wrong (lane M1, migration 0039).
 *
 * `funnel_facts` is append-only — DELETE is revoked (0022) — so a fact is never removed: it
 * is marked withdrawn, with a reason code, and every reader skips it (`funnel/read.ts`). The
 * row keeps its dedupe key, so the same fact confirmed again later is the same row
 * reinstated (`reinstateFunnelFact`), never a second one. Answers how many it withdrew; a
 * fact already withdrawn is left with its first reason.
 */
export async function withdrawFunnelFacts(
  context: RepositoryContext,
  input: { readonly kind: string; readonly dedupeKeys: readonly string[]; readonly reason: string },
): Promise<number> {
  if (!FUNNEL_WITHDRAWN_REASON_SHAPE.test(input.reason)) throw new Error('a withdrawal reason is a lower-case code');
  if (input.dedupeKeys.length === 0) return 0;
  const { rowCount } = await context.db.query(
    `UPDATE funnel_facts SET withdrawn_at = now(), withdrawn_reason = $4
      WHERE workspace_id = $1 AND kind = $2 AND dedupe_key = ANY($3::text[]) AND withdrawn_at IS NULL`,
    [context.scope.workspaceId, input.kind, [...input.dedupeKeys], input.reason],
  );
  return rowCount ?? 0;
}

/**
 * Make one fact of `kind` under any of `dedupeKeys` count again, if one was withdrawn and
 * none counts now. The one keyed by `preferredKey` first, else the earliest. Answers
 * `live` when one already counted, `reinstated` when it brought one back, and `absent`
 * when there is none to bring back (the caller records it with `recordFunnelFact`). A
 * reinstated fact keeps the actor and instant it was first written with.
 */
export async function reinstateFunnelFact(
  context: RepositoryContext,
  input: { readonly kind: string; readonly dedupeKeys: readonly string[]; readonly preferredKey: string },
): Promise<'live' | 'reinstated' | 'absent'> {
  const keys = [...new Set([input.preferredKey, ...input.dedupeKeys])];
  const { rows } = await context.db.query<{ id: string; withdrawn: boolean }>(
    `SELECT id, withdrawn_at IS NOT NULL AS withdrawn FROM funnel_facts
      WHERE workspace_id = $1 AND kind = $2 AND dedupe_key = ANY($3::text[])
      ORDER BY (withdrawn_at IS NULL) DESC, (dedupe_key = $4) DESC, occurred_at, id
      FOR UPDATE`,
    [context.scope.workspaceId, input.kind, keys, input.preferredKey],
  );
  const first = rows[0];
  if (first === undefined) return 'absent';
  if (!first.withdrawn) return 'live';
  await context.db.query('UPDATE funnel_facts SET withdrawn_at = NULL, withdrawn_reason = NULL WHERE workspace_id = $1 AND id = $2', [
    context.scope.workspaceId,
    first.id,
  ]);
  return 'reinstated';
}
