import type { SuppressionSource } from '@fss/contracts';
import { MANUAL_SUPPRESSION_CORRECTION_SECONDS } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { databaseNow } from '../policy/clock.ts';
import { openHold } from '../policy/holds.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { claimFinalization } from './finalize.ts';
import { REVIEW_HOLD_BLOCKS, readSuppressionEvent } from './events.ts';
import { SUPPRESSION_JOURNAL_SCHEMA, type SuppressionJournalRecord } from './journal.ts';

/**
 * Appendix E step 2: "replay the suppression journal from the restore point minus one
 * hour; insert every missing event idempotently."
 *
 * The journal is the one pre-acknowledgement write outside PostgreSQL, so after a
 * point-in-time restore it holds suppressions the database has lost. This is the
 * function that puts them back, and three things about it are the whole design.
 *
 * **It does not append.** `recordSuppression` journals before it inserts, because the
 * journal write is the precondition of acknowledging a suppression. A replay is the
 * other direction: the object is already durable — it is where the record came from —
 * and appending it again would be writing to an object-locked bucket for no reason.
 *
 * **It writes the journalled instant, not now.** `recorded_at` is what decides whether
 * a manual suppression's ten-minute window had already closed when the database was
 * lost, and a replay that stamped its own time would reopen a window the prospect's
 * side of which had long since expired. So the row keeps the instant the journal
 * recorded and the window is evaluated against database time.
 *
 * **A record for another workspace is refused, never moved.** The journal object key
 * carries the workspace and so does the record; a replay run for one workspace that
 * silently inserted another's event would be the only way a suppression could cross a
 * workspace boundary in this system.
 */

export type JournalParseRefusal = 'not_json' | 'not_object' | 'schema_unknown' | 'field_missing';

export type JournalParseResult =
  | { readonly ok: true; readonly value: SuppressionJournalRecord }
  | { readonly ok: false; readonly reason: JournalParseRefusal; readonly detail: string };

/**
 * One journal object's body, as a record.
 *
 * The parser is strict and total: both processes write this shape with
 * `journalObjectBody`, so a body that does not carry a field is a corrupt object rather
 * than a default to invent.
 * The only optional fields are the four the writers emit as `null`.
 */
export function parseSuppressionJournalRecord(body: string): JournalParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'not_json', detail: 'the journal object does not hold JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_object', detail: 'the journal object does not hold a JSON object' };
  }
  const object = parsed as Record<string, unknown>;
  if (object['schema'] !== SUPPRESSION_JOURNAL_SCHEMA) {
    return { ok: false, reason: 'schema_unknown', detail: String(object['schema'] ?? '') };
  }
  const text = (name: string): string | null => (typeof object[name] === 'string' ? (object[name] as string) : null);
  const required = ['eventId', 'workspaceId', 'scope', 'canonicalKey', 'canonicalizerVersion', 'source', 'recordedAt'];
  for (const name of required) {
    if (text(name) === null) return { ok: false, reason: 'field_missing', detail: name };
  }
  const scope = text('scope');
  if (scope !== 'firm' && scope !== 'handle') return { ok: false, reason: 'field_missing', detail: 'scope' };
  return {
    ok: true,
    value: {
      eventId: text('eventId') ?? '',
      workspaceId: text('workspaceId') ?? '',
      scope,
      canonicalKey: text('canonicalKey') ?? '',
      canonicalizerVersion: text('canonicalizerVersion') ?? '',
      source: text('source') ?? '',
      actorUserId: text('actorUserId'),
      commandId: text('commandId'),
      supersedesEventId: text('supersedesEventId'),
      supersessionReason: text('supersessionReason'),
      recordedAt: text('recordedAt') ?? '',
    },
  };
}

/**
 * Where a replay reads the journal from.
 *
 * The port is here and no S3 client is: `@fss/domain` calls no cloud service. The
 * implementation is `apps/worker/src/tools/fss/journalSource.ts`, which lists and
 * gets the objects with the same lazily imported SDK the append path uses.
 */
export interface SuppressionJournalSource {
  /** Every record written at or after `from`, in any order. */
  read(from: string, to?: string | undefined): Promise<readonly SuppressionJournalRecord[]>;
}

export interface JournalReplayReport {
  readonly inserted: number;
  readonly alreadyPresent: number;
  /** Records naming another workspace. Refused, never moved. */
  readonly foreign: number;
  /** Events that arrived already past their correction window and were finalized. */
  readonly finalized: number;
  /** Manual events still inside their window: a review hold and a finalizer job. */
  readonly windowsReopened: number;
}

/** The sources that are terminal the instant they commit (10.2). Mirrors `events.ts`. */
const TERMINAL_SOURCES: ReadonlySet<string> = new Set([
  'prospect_opt_out',
  'prospect_do_not_call',
  'import',
  'deletion_tombstone',
]);

export interface ReplayInput {
  readonly records: readonly SuppressionJournalRecord[];
}

/**
 * Insert every journalled event this workspace is missing. Idempotent by event id.
 *
 * The caller owns the transaction. One transaction for the whole replay is the right
 * shape: a half-applied replay would leave a restore drill unable to say which events
 * it had put back, and the set is bounded by an hour of a single workspace's journal.
 */
export async function replaySuppressionJournal(
  context: RepositoryContext,
  input: ReplayInput,
): Promise<JournalReplayReport> {
  // A replayed suppression stops sends exactly as the original did (lane g77).
  await lockSendGateForStopFact(context);
  const now = await databaseNow(context);
  let inserted = 0;
  let alreadyPresent = 0;
  let foreign = 0;
  let finalized = 0;
  let windowsReopened = 0;

  for (const record of input.records) {
    if (record.workspaceId !== context.scope.workspaceId) {
      foreign += 1;
      continue;
    }
    if ((await readSuppressionEvent(context, record.eventId)) !== null) {
      alreadyPresent += 1;
      continue;
    }

    await context.db.query(
      `INSERT INTO suppression_events
         (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
          actor_user_id, command_id, recorded_at, supersedes_event_id, supersession_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11)`,
      [
        context.scope.workspaceId,
        record.eventId,
        record.scope,
        record.canonicalKey,
        record.canonicalizerVersion,
        record.source as SuppressionSource,
        record.actorUserId,
        record.commandId,
        record.recordedAt,
        record.supersedesEventId,
        record.supersessionReason,
      ],
    );
    inserted += 1;

    const terminal = TERMINAL_SOURCES.has(record.source);
    const deadline = Date.parse(record.recordedAt) + MANUAL_SUPPRESSION_CORRECTION_SECONDS * 1000;
    if (terminal || deadline <= Date.parse(now)) {
      // Appendix G 30 and the drill's step 2: a prospect-originated opt-out is
      // terminal, and a manual suppression whose window expired before the failure
      // finalises terminally rather than reopening.
      await claimFinalization(context, { eventId: record.eventId, outcome: 'finalized' });
      finalized += 1;
      continue;
    }

    // Still inside the window. The row the correction claims against has to exist and
    // the finalizer has to be owed, or the suppression would sit unfinalized forever.
    if (record.scope === 'firm') {
      await openHold(context, {
        scopeKind: 'firm',
        scopeKey: record.canonicalKey,
        reasonCode: 'manual_suppression_review',
        blockedActionKinds: REVIEW_HOLD_BLOCKS,
        sourceEventKind: 'suppression.manual',
        sourceEventId: record.eventId,
        ...(record.actorUserId === null ? {} : { ownerUserId: record.actorUserId }),
      });
    }
    await enqueueJob(context.db, {
      workspaceId: context.scope.workspaceId,
      kind: 'suppression.finalize',
      idempotencyKey: jobIdempotencyKey.suppressionFinalize(record.eventId),
      payload: { eventId: record.eventId },
      runAt: new Date(deadline).toISOString(),
      notBefore: new Date(deadline).toISOString(),
    });
    windowsReopened += 1;
  }

  return { inserted, alreadyPresent, foreign, finalized, windowsReopened };
}
