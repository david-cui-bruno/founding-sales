import type { RepositoryContext } from '../db/workspaceScope.ts';
import { actorKind, actorUserId } from '../crm/types.ts';
import { FUNNEL_KIND_SHAPE, FUNNEL_SOURCE_SHAPE } from './kinds.ts';

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
 *   * **Refused before the insert.** A kind or a source of the wrong shape is a
 *     refusal this function makes, not a constraint crash. The reason is the same
 *     either way; the difference is that the caller's transaction survives it and
 *     can decide what to do.
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

export type FunnelFactOutcome =
  | { readonly recorded: true; readonly id: string }
  | { readonly recorded: false; readonly reason: 'duplicate' | 'invalid_kind' | 'invalid_source' };

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
      JSON.stringify(input.detail ?? {}),
      input.occurredAt ?? null,
    ],
  );

  const id = rows[0]?.id;
  if (id === undefined) return { recorded: false, reason: 'duplicate' };
  return { recorded: true, id };
}
