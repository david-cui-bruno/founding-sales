import type { RepositoryContext } from '../db/workspaceScope.ts';
import { actorKind, actorUserId } from './types.ts';

/**
 * The CRM's domain-event outbox: the hook the later lanes subscribe to.
 *
 * G3a's brief asks for "terminal stops hooked for G8 through an event the sequences
 * lane will subscribe to (define the hook, do not implement sequences)", and
 * Appendix A's `Reassign firm` row asks for a "Today transfer hook". This is both,
 * and it is one table rather than two seams, because they want the same thing: a
 * durable record, written in the transaction that caused it, that a lane which does
 * not exist yet can read later without this lane knowing anything about it.
 *
 * Three properties make it safe to subscribe to:
 *
 *   * **Committed or absent.** The row is written in the business transaction, so a
 *     subscriber that sees it is looking at a fact, and a rolled-back command leaves
 *     no signal to act on.
 *   * **Deduplicated by the database.** `UNIQUE (workspace_id, event_kind,
 *     dedupe_key)` means a command replayed under the same command id, or a handler
 *     run twice, produces one signal. The key is built here, never at a call site.
 *   * **Append-only by privilege.** UPDATE, DELETE and TRUNCATE are revoked, so a
 *     subscriber's progress is its own business and no writer can rewrite history.
 *
 * What it deliberately is not: a `jobs` row. Appendix C's job kinds are a closed set
 * the queue owns, no handler is registered for any of these yet, and a job nobody
 * handles becomes a dead job and then an alert. See
 * `docs/decisions/g3a-domain-event-outbox.md`.
 */

export const CRM_DOMAIN_EVENT_KINDS = [
  /** Won or Lost: every active enrollment for the firm stops terminally (8.1). G8. */
  'opportunity.terminal_stop',
  /** The opportunity became manual; automation never reverses it (7.3). G8. */
  'opportunity.manual_mode',
  /** An explicit reopen. It never restarts old automation (8.1). G8. */
  'opportunity.reopened',
  /** The firm changed hands; unfinished Today entries transfer (8.2, Appendix A). */
  'firm.reassigned',
  /** Records merged; search and Today reindex the target (Appendix A). */
  'firm.merged',
  'contact.merged',
  /** A route was retired; a card holding its old version must not dial (9.1). G4. */
  'route.retired',
] as const;
export type CrmDomainEventKind = (typeof CRM_DOMAIN_EVENT_KINDS)[number];

/**
 * How an opportunity came to be manual (7.3, lane G22).
 *
 * 7.3 names the ways in — a confirmed human email reply, an engaged call outcome or a
 * direct Gmail send (its user-recorded LinkedIn reply went with LinkedIn on 25
 * September 2026) — and `ENROLLMENT_END_REASONS` has a member for each of them. Lane
 * G15 drained the `opportunity.manual_mode` signal and had to record `human_reply` for
 * all of them, because the event carried only
 * `reason_code = 'opportunity_manual'` and a free-text reason, and parsing English out
 * of a detail column to choose a stored code would have been worse than recording the
 * one fact the consumer could prove.
 *
 * The origin is that fact, written by the caller that knows it, into
 * `crm_domain_events.detail.origin` — a jsonb column that already exists, so nothing
 * here needs a migration. A fourth member, `salesperson_command`, is the explicit
 * `POST /opportunities/manual`: a person inside deciding, which 7.3 does not list
 * because it is not a prospect signal, and which the enrollment vocabulary calls
 * `admin_stop`.
 *
 * An event written before this lane carries no origin at all, and every reader still
 * works: `manualModeEndReason` maps an absent or unrecognised origin to `human_reply`,
 * which is exactly what G15 recorded. An event written before 25 September 2026 with
 * the removed `linkedin_reply` origin is one of those.
 */
export const MANUAL_MODE_ORIGINS = [
  'human_reply',
  'engaged_call',
  'direct_send',
  'salesperson_command',
] as const;
export type ManualModeOrigin = (typeof MANUAL_MODE_ORIGINS)[number];

export interface CrmDomainEventInput {
  readonly kind: CrmDomainEventKind;
  readonly firmId: string;
  readonly opportunityId?: string | undefined;
  readonly contactId?: string | undefined;
  /** One signal per (kind, key). Built by the caller from the ids that identify the change. */
  readonly dedupeKey: string;
  /** A `hold_reason_codes.code` when the signal is a hold's cause. */
  readonly reasonCode?: string | undefined;
  readonly commandId?: string | undefined;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Write one signal. Idempotent: a second call with the same kind and dedupe key is a
 * no-op rather than a unique violation, because a command replay must not abort the
 * transaction it is replaying inside.
 */
export async function emitCrmDomainEvent(
  context: RepositoryContext,
  event: CrmDomainEventInput,
): Promise<void> {
  await context.db.query(
    `INSERT INTO crm_domain_events
       (workspace_id, event_kind, firm_id, opportunity_id, contact_id, dedupe_key,
        reason_code, actor_kind, actor_user_id, command_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT ON CONSTRAINT crm_domain_events_dedupe DO NOTHING`,
    [
      context.scope.workspaceId,
      event.kind,
      event.firmId,
      event.opportunityId ?? null,
      event.contactId ?? null,
      event.dedupeKey,
      event.reasonCode ?? null,
      actorKind(context),
      actorUserId(context),
      event.commandId ?? null,
      JSON.stringify(event.detail ?? {}),
    ],
  );
}

/**
 * The signals a subscriber has not yet consumed, oldest first.
 *
 * There is no consumption column: a subscriber records its own high-water mark, which
 * is what keeps this table append-only and lets two lanes read the same stream at
 * different speeds. G8 and the Today lane each pass their own `after`.
 */
export async function readCrmDomainEvents(
  context: RepositoryContext,
  options: { readonly kinds: readonly CrmDomainEventKind[]; readonly after?: string; readonly limit?: number },
): Promise<readonly { readonly id: string; readonly kind: CrmDomainEventKind; readonly firmId: string; readonly opportunityId: string | null; readonly occurredAt: Date }[]> {
  const { rows } = await context.db.query<{
    id: string;
    event_kind: CrmDomainEventKind;
    firm_id: string;
    opportunity_id: string | null;
    occurred_at: Date;
  }>(
    `SELECT id, event_kind, firm_id, opportunity_id, occurred_at
       FROM crm_domain_events
      WHERE workspace_id = $1
        AND event_kind = ANY($2::text[])
        AND ($3::timestamptz IS NULL OR occurred_at > $3::timestamptz)
      ORDER BY occurred_at, id
      LIMIT $4`,
    [context.scope.workspaceId, options.kinds, options.after ?? null, Math.trunc(options.limit ?? 100)],
  );
  return rows.map(row => ({
    id: row.id,
    kind: row.event_kind,
    firmId: row.firm_id,
    opportunityId: row.opportunity_id,
    occurredAt: row.occurred_at,
  }));
}
