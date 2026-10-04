import type { RepositoryContext } from '../db/workspaceScope.ts';
import { localDate } from '../src/rules/localClock.ts';
import { lockMonthlySpend } from './ledger.ts';

/**
 * One row per paid attempt, from authorized to settled (`provider_reservations`).
 *
 * A paid provider call cannot happen inside the transaction that records it: the call
 * is out in the world before the commit, so a rollback loses the record and keeps the
 * invoice. This module is how that is survived.
 *
 * It replaces a `reserved_cents` column on the aggregate ledger, and the difference is
 * not bookkeeping taste. A counter can be incremented by one run and decremented by
 * another: a run authorized yesterday, settling today, released *today's* cents, which
 * is a silent loss of the other run's authorization. A row has an identity, a date of
 * its own and a state, so a call is settled exactly once, by id, on the date whose
 * budget cleared it.
 *
 * ## The state machine, in five lines
 *
 *   * `reserved` — cents authorized, nothing called. A crash here can be `released`,
 *     because no call can have happened.
 *   * `calling` — committed **before** the call. The durable marker that says a call may
 *     now have happened, and the reason a retry cannot quietly make a second free one.
 *   * `settled` — the provider reported a figure; `settled_cents` is that figure.
 *   * `estimated` — nobody reported one (a throw, no `usage`, a lost lease);
 *     `settled_cents` is the reservation, because zero is certainly wrong.
 *   * `released` — no call happened and none can have; `settled_cents` is zero.
 *
 * ## The one asymmetry: `calling` is released by nobody else
 *
 * `reserved → released` is a fact anybody may write. `calling → released` is not: the
 * marker says a call may be in flight, so a caller that releases it is claiming to know
 * something only the claim holding the run's lock can know. The abandoned-run sweep used
 * to be allowed to do it, and between its read of the state and its write a live claim
 * could mark the row — so the sweep released the cents while the call went out. From
 * `calling` the settlements are `settled`, `estimated`, and `released_not_called` for
 * the one claim that marked the row and then declined to call.
 *
 * ## Why the attempt is in the key
 *
 * A retry's reservation is a different row from the attempt it retries. Reusing one row
 * would mean either settling it twice or calling twice against one authorization, and
 * the handler's `maxAttempts` then bounds the rows: three reservations is the worst one
 * firm can cost in a day, which is a number a person can check.
 *
 * Generic on purpose. `subject_kind` has one value today and exists so the telephony
 * lane adds a value rather than a table.
 */

export const RESERVATION_STATES = ['reserved', 'calling', 'settled', 'estimated', 'released'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

/** The states in which cents are authorized and not yet invoiced. `readSpend` counts these. */
export const OPEN_RESERVATION_STATES: readonly ReservationState[] = Object.freeze(['reserved', 'calling']);

export interface ReservationRow {
  readonly id: string;
  readonly providerKey: string;
  readonly attempt: number;
  readonly businessDate: string;
  readonly businessTimeZone: string;
  readonly cents: number;
  /**
   * The priced shape of the call these cents authorize, as it was at the moment they
   * were cleared. Chunk 3 admits its request against these three and never against the
   * settings, which are mutable: see `pricing.admitCall`.
   */
  readonly modelName: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly state: ReservationState;
  readonly settledCents: number;
}

interface ReservationDbRow {
  readonly id: string;
  readonly provider_key: string;
  readonly attempt: number;
  readonly business_date: string;
  readonly business_time_zone: string;
  readonly cents: number;
  readonly model_name: string;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly state: ReservationState;
  readonly settled_cents: number;
  readonly [column: string]: unknown;
}

const COLUMNS = `id, provider_key, attempt, business_date::text AS business_date, business_time_zone,
  cents, model_name, max_input_tokens, max_output_tokens, state, settled_cents`;

const toRow = (row: ReservationDbRow): ReservationRow => ({
  id: row.id,
  providerKey: row.provider_key,
  attempt: Number(row.attempt),
  businessDate: row.business_date,
  businessTimeZone: row.business_time_zone,
  cents: Number(row.cents),
  modelName: row.model_name,
  maxInputTokens: Number(row.max_input_tokens),
  maxOutputTokens: Number(row.max_output_tokens),
  state: row.state,
  settledCents: Number(row.settled_cents),
});

/** The subjects priced by model and tokens: research runs, replies (slice P1) and call summaries (slice C3b). */
export type TokenPricedSubjectKind = 'research_run' | 'reply_classification' | 'call_summary' | 'call_analysis' | 'meeting_analysis';

export interface ReserveInput {
  readonly providerKey: string;
  readonly subjectKind: TokenPricedSubjectKind;
  readonly subjectId: string;
  readonly attempt: number;
  /** Database time. The reservation's own business date is derived from it here. */
  readonly at: string;
  readonly businessTimeZone: string;
  readonly cents: number;
  /**
   * The three numbers `cents` was computed from, snapshotted onto the row.
   *
   * They come from the clearance rather than from a caller's own reading of the
   * settings, because the reservation *is* the authorization: what may be sent against
   * it has to be decided from what was priced, not from what the settings say by the
   * time the call is made.
   */
  readonly modelName: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Authorize one attempt's cents, or hand back the row that already exists.
 *
 * `ON CONFLICT DO NOTHING` on the attempt key, then a read: a handler whose chunk
 * committed and whose cursor was then lost re-enters here and finds its own row rather
 * than making a second one. The insert is the check, so there is no window between
 * asking and writing.
 */
export async function reserveAttempt(
  context: RepositoryContext,
  input: ReserveInput,
): Promise<ReservationRow> {
  const businessDate = localDate(input.at, input.businessTimeZone);
  await context.db.query(
    `INSERT INTO provider_reservations
       (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date,
        business_time_zone, cents, model_name, max_input_tokens, max_output_tokens, state)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, 'reserved')
     ON CONFLICT ON CONSTRAINT provider_reservations_one_per_attempt DO NOTHING`,
    [
      context.scope.workspaceId,
      input.providerKey,
      input.subjectKind,
      input.subjectId,
      Math.max(1, Math.trunc(input.attempt)),
      businessDate,
      input.businessTimeZone,
      Math.max(0, Math.trunc(input.cents)),
      input.modelName,
      Math.max(1, Math.trunc(input.maxInputTokens)),
      Math.max(1, Math.trunc(input.maxOutputTokens)),
    ],
  );
  const row = await readAttempt(context, input);
  if (row === null) throw new Error('a reservation just inserted could not be read back');
  return row;
}

/** One attempt's reservation, or null. */
export async function readAttempt(
  context: RepositoryContext,
  input: { readonly subjectKind: TokenPricedSubjectKind; readonly subjectId: string; readonly attempt: number },
): Promise<ReservationRow | null> {
  const { rows } = await context.db.query<ReservationDbRow>(
    `SELECT ${COLUMNS} FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND subject_id = $3 AND attempt = $4`,
    [context.scope.workspaceId, input.subjectKind, input.subjectId, Math.trunc(input.attempt)],
  );
  const row = rows[0];
  return row === undefined ? null : toRow(row);
}

/**
 * Every reservation of one subject, newest attempt first.
 *
 * What the handler reads to recover its own step when the cursor is missing or
 * malformed: the newest row's state says where the run got to, which is more
 * trustworthy than a cursor because it is the same fact the money is recorded against.
 */
export async function listAttempts(
  context: RepositoryContext,
  input: { readonly subjectKind: TokenPricedSubjectKind; readonly subjectId: string },
): Promise<readonly ReservationRow[]> {
  const { rows } = await context.db.query<ReservationDbRow>(
    `SELECT ${COLUMNS} FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND subject_id = $3
      ORDER BY attempt DESC`,
    [context.scope.workspaceId, input.subjectKind, input.subjectId],
  );
  return rows.map(toRow);
}

/**
 * Commit "a call may now have happened" for one reservation.
 *
 * The whole of chunk 2. It writes nothing else on purpose: a marker that shares a
 * transaction with work is a marker that can be rolled back by that work's failure,
 * and then the call that followed it has no record at all.
 *
 * Idempotent, and deliberately narrow — only a `reserved` row moves. Re-entering on a
 * row that is already `calling` returns false, which is exactly the ambiguity the
 * caller has to resolve rather than paper over.
 */
export async function markCalling(context: RepositoryContext, reservationId: string): Promise<boolean> {
  const { rowCount } = await context.db.query(
    `UPDATE provider_reservations SET state = 'calling'
      WHERE workspace_id = $1 AND id = $2 AND state = 'reserved'`,
    [context.scope.workspaceId, reservationId],
  );
  return (rowCount ?? 0) > 0;
}

export type SettleOutcome =
  /** The provider reported a figure. */
  | { readonly kind: 'settled'; readonly cents: number }
  /**
   * Nobody reported one. The reservation is the cost — unless the caller has a better
   * estimate than the worst case (telephony: the call's own duration at the reserved
   * unit price, `calls/sessions.ts`), which it passes as `cents`.
   */
  | { readonly kind: 'estimated'; readonly cents?: number | undefined }
  /**
   * No call happened and none can have — permitted **only** from `reserved`.
   *
   * `reserved` is the one state in which "no call happened" is a fact about the row
   * rather than a belief of the caller's. A third party that releases a `calling` row
   * is claiming to know something it cannot: the marker exists precisely because
   * somebody may be in the middle of the call. The sweep's release used to be allowed
   * from `calling`, and between its read and its write a live claim could mark the row —
   * so the sweep handed the cents back under a call that was about to be billed.
   */
  | { readonly kind: 'released' }
  /**
   * No call happened, and this caller is the one that would have made it.
   *
   * The only way a `calling` row is released. Chunk 3 marks its own reservation in
   * chunk 2 and then sometimes declines to call at all — the fetch failed, the exact
   * token count did not fit the reservation — and it is the one caller with first-hand
   * knowledge of that, holding the run row's lock while it says so. Nothing that reads
   * the row from outside may use this.
   */
  | { readonly kind: 'released_not_called' };

/**
 * Close one reservation, exactly once, by id.
 *
 * Returns what was actually recorded, which is zero when the row was already closed —
 * so a caller that runs twice adds cents once. The guard is in the statement rather
 * than in a read-then-write, because the whole point of this table is to be right when
 * the process disappears between two statements.
 *
 * The guard is also *asymmetric*, and that is the money rule of the state machine: a
 * `calling` row may be settled or estimated by anybody, and released by nobody except
 * the claim that marked it (`released_not_called`). See `SettleOutcome`.
 */
export async function settleAttempt(
  context: RepositoryContext,
  input: { readonly reservationId: string; readonly at: string; readonly outcome: SettleOutcome },
): Promise<{ readonly recordedCents: number; readonly state: ReservationState } | null> {
  const state: ReservationState =
    input.outcome.kind === 'settled' ? 'settled' : input.outcome.kind === 'estimated' ? 'estimated' : 'released';
  // Whether a row still marked `calling` may be closed this way. Everything except a
  // third party's `released` may; see `SettleOutcome`.
  const fromCalling = input.outcome.kind !== 'released';
  const { rows } = await context.db.query<{
    business_date: string;
    business_time_zone: string;
    provider_key: string;
    settled_cents: number;
  }>(
    `UPDATE provider_reservations
        SET state = $3,
            settled_cents = CASE
              WHEN $3 = 'settled' THEN $4::integer
              WHEN $3 = 'estimated' THEN COALESCE($7::integer, cents)
              ELSE 0
            END,
            settled_at = $5::timestamptz
      WHERE workspace_id = $1 AND id = $2
        AND (state = 'reserved' OR (state = 'calling' AND $6::boolean))
      RETURNING business_date::text AS business_date, business_time_zone, provider_key, settled_cents`,
    [
      context.scope.workspaceId,
      input.reservationId,
      state,
      input.outcome.kind === 'settled' ? Math.max(0, Math.trunc(input.outcome.cents)) : 0,
      input.at,
      fromCalling,
      input.outcome.kind === 'estimated' && input.outcome.cents !== undefined
        ? Math.max(0, Math.trunc(input.outcome.cents))
        : null,
    ],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const recordedCents = Number(row.settled_cents);
  if (recordedCents > 0) {
    // The invoice goes to the ledger row of the reservation's **own** date and zone. A
    // run authorized yesterday and settled today belongs to yesterday's budget, which is
    // the day that cleared it.
    await addLedgerCost(context, {
      providerKey: row.provider_key,
      businessDate: row.business_date,
      businessTimeZone: row.business_time_zone,
      cents: recordedCents,
    });
  }
  return { recordedCents, state };
}

/**
 * Replace a closed reservation's recorded cost with the provider's own figure, and move the
 * ledger by the difference (slice P1, finding 5).
 *
 * Telephony's terminal callback may settle a call from its duration (an estimate) or from
 * a first price, and a later callback can carry Twilio's final price. The provider's
 * figure is the cost, so the row becomes `settled` at it and the ledger row of the
 * reservation's own date moves by `new − previous`. Idempotent: a figure already recorded
 * changes nothing. The caller holds the workspace's monthly lock.
 */
export async function correctSettledCents(
  context: RepositoryContext,
  input: { readonly reservationId: string; readonly cents: number },
): Promise<{ readonly previous: number; readonly recorded: number } | null> {
  const cents = Math.max(0, Math.trunc(input.cents));
  await lockMonthlySpend(context);
  const { rows } = await context.db.query<{
    previous: number;
    business_date: string;
    business_time_zone: string;
    provider_key: string;
  }>(
    `WITH old AS (
       SELECT id, settled_cents FROM provider_reservations
        WHERE workspace_id = $1 AND id = $2 AND state IN ('settled', 'estimated')
        FOR UPDATE
     )
     UPDATE provider_reservations p
        SET state = 'settled', settled_cents = $3
       FROM old
      WHERE p.workspace_id = $1 AND p.id = old.id AND (p.settled_cents <> $3 OR p.state <> 'settled')
      RETURNING old.settled_cents AS previous, p.business_date::text AS business_date, p.business_time_zone, p.provider_key`,
    [context.scope.workspaceId, input.reservationId, cents],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const delta = cents - Number(row.previous);
  if (delta !== 0) {
    await context.db.query(
      `INSERT INTO provider_ledger
         (workspace_id, provider_key, business_date, business_time_zone, calls, failures, cost_cents, updated_at)
       VALUES ($1, $2, $3::date, $4, 0, 0, greatest(0, $5::integer), now())
       ON CONFLICT (workspace_id, provider_key, business_date) DO UPDATE
          SET cost_cents = greatest(0, provider_ledger.cost_cents + $5::integer), updated_at = now()`,
      [context.scope.workspaceId, row.provider_key, row.business_date, row.business_time_zone, delta],
    );
  }
  return { previous: Number(row.previous), recorded: cents };
}

/**
 * Add invoiced cents to one ledger row, by an explicit date.
 *
 * Separate from `recordProviderCall` because a settlement is not a call: the call was
 * counted when it was made, and counting it again here would make every paid run two
 * calls in the ledger.
 */
async function addLedgerCost(
  context: RepositoryContext,
  input: {
    readonly providerKey: string;
    readonly businessDate: string;
    readonly businessTimeZone: string;
    readonly cents: number;
  },
): Promise<void> {
  // The monthly spend lock before the ledger row, as every ledger write takes it.
  await lockMonthlySpend(context);
  await context.db.query(
    `INSERT INTO provider_ledger
       (workspace_id, provider_key, business_date, business_time_zone, calls, failures, cost_cents, updated_at)
     VALUES ($1, $2, $3::date, $4, 0, 0, $5::integer, now())
     ON CONFLICT (workspace_id, provider_key, business_date) DO UPDATE
        SET cost_cents = provider_ledger.cost_cents + $5::integer, updated_at = now()`,
    [context.scope.workspaceId, input.providerKey, input.businessDate, input.businessTimeZone, Math.trunc(input.cents)],
  );
}

/**
 * Close every open reservation of one subject, and say what the subject cost.
 *
 * For the abandoned-run sweep. A reservation that reached `calling` is `estimated`,
 * because the last thing the vanished worker may have done was make the call; one still
 * `reserved` is `released`, because no call could have happened. The sum is what the run
 * row records, with `cost_estimated` true.
 */
export async function finaliseSubjectReservations(
  context: RepositoryContext,
  input: { readonly subjectKind: TokenPricedSubjectKind; readonly subjectId: string; readonly at: string },
): Promise<{ readonly cents: number; readonly estimated: boolean }> {
  let cents = 0;
  let estimated = false;
  for (const row of await listAttempts(context, input)) {
    if (!OPEN_RESERVATION_STATES.includes(row.state)) {
      cents += row.settledCents;
      if (row.state === 'estimated') estimated = true;
      continue;
    }
    const outcome: SettleOutcome = row.state === 'calling' ? { kind: 'estimated' } : { kind: 'released' };
    const settled = await settleAttempt(context, { reservationId: row.id, at: input.at, outcome });
    cents += settled?.recordedCents ?? 0;
    if (row.state === 'calling') estimated = true;
  }
  return { cents, estimated };
}

/** Everything one subject has been recorded as costing, settled rows only. */
export async function subjectSettledCents(
  context: RepositoryContext,
  input: { readonly subjectKind: TokenPricedSubjectKind; readonly subjectId: string },
): Promise<number> {
  const { rows } = await context.db.query<{ cents: string | null }>(
    `SELECT sum(settled_cents)::text AS cents FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND subject_id = $3`,
    [context.scope.workspaceId, input.subjectKind, input.subjectId],
  );
  return Number(rows[0]?.cents ?? '0');
}
