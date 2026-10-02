import type { SuppressionSource } from '@fss/contracts';
import { MANUAL_SUPPRESSION_CORRECTION_SECONDS } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { databaseNow } from '../policy/clock.ts';
import { openHold, releaseHoldsOfEvent } from '../policy/holds.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { claimFinalization, readFinalization } from './finalize.ts';
import { isMergeCopyId, lockSuppressionHistory, readSuppressionEvent, reviewHoldBlocks } from './events.ts';
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
 * The only optional fields are the four the writers emit as `null`, and `channel`, which
 * objects written before migration 0037 do not carry and which then reads `all`.
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
  // Migration 0037's channel: absent (every object written before it) is `all`; anything
  // other than the three channels is a corrupt object, not a default to invent.
  const channel = object['channel'] === undefined ? 'all' : object['channel'];
  if (channel !== 'phone' && channel !== 'email' && channel !== 'all') {
    return { ok: false, reason: 'field_missing', detail: 'channel' };
  }
  // The firm the live write opened its review hold on (brief RF, X5): a string, or null when
  // the write named none; absent on every object written before RF, which says nothing.
  const firmId = object['firmId'];
  if (firmId !== undefined && firmId !== null && typeof firmId !== 'string') {
    return { ok: false, reason: 'field_missing', detail: 'firmId' };
  }
  // The release marker (J2): only `true` means committed; anything else is no marker.
  const committed = object['committed'] === true;
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
      channel,
      ...(firmId === undefined ? {} : { firmId }),
      ...(committed ? { committed: true as const } : {}),
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
  /** Supersessions replayed: each a release of its original's review hold, never a stop. */
  readonly released: number;
  /**
   * Supersessions of an event that another supersession of it already lifts (brief RF, R2):
   * the journal object of a race's loser. Ids only; never inserted.
   */
  readonly competingSupersessions: readonly string[];
  /**
   * Supersessions whose original is neither in the database nor in the records read: there
   * is nothing for them to lift, and the foreign key would refuse them. Ids only; skipped.
   */
  readonly orphanSupersessions: readonly string[];
  /**
   * Corrections whose original was already decided `finalized` when the replay reached them
   * (brief RF, review P1): the correction never committed live (its stop was finalized
   * instead), so it is neither inserted nor allowed to release anything. Ids only.
   */
  readonly staleCorrections: readonly string[];
  /**
   * Manual handle stops inside their window whose journal object predates RF and so does
   * not say which firm the live write held (review P3). Their hold is not guessed. Ids only.
   */
  readonly unreconstructedHolds: readonly string[];
  /**
   * Releases journalled before the RF reset, without the `committed` marker (J3): written
   * inside a transaction that may have rolled back, so not applied. David lifts the stop again
   * if it should be lifted. Ids only.
   */
  readonly unverifiedLegacyReleases: readonly string[];
}

/** A merge's copy, in either form (`isMergeCopyId`), live a bare row: no claim, no hold, no finalizer. */
const isMergeCopy = (record: SuppressionJournalRecord): boolean => isMergeCopyId(record.eventId);

/** The sources that are terminal the instant they commit (10.2). Mirrors `events.ts`. */
const TERMINAL_SOURCES: ReadonlySet<string> = new Set([
  'prospect_opt_out',
  'prospect_do_not_call',
  'import',
  'deletion_tombstone',
]);

/**
 * The sources that lift another event (0001's `suppression_events_supersession_consistent`).
 * A replayed one is a release, as the live write was (brief RF, R4): it opens no hold and is
 * owed no finalizer, and it releases its original's review hold.
 */
const SUPERSESSION_SOURCES: ReadonlySet<string> = new Set(['mistaken_entry_correction', 'admin_supersession']);

/** Earliest first, by the journalled instant and then the id: the replay's one order. */
const byRecordedTime = (left: SuppressionJournalRecord, right: SuppressionJournalRecord): number => {
  const difference = Date.parse(left.recordedAt) - Date.parse(right.recordedAt);
  if (difference !== 0) return difference;
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
};

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
  // A replayed suppression stops sends exactly as the original did (lane g77). Then the
  // history lock every supersession and the merge take (brief RF), in that order.
  await lockSendGateForStopFact(context);
  await lockSuppressionHistory(context);
  const now = await databaseNow(context);
  let alreadyPresent = 0;
  let foreign = 0;

  // The records this workspace is missing, once each.
  const missing = new Map<string, SuppressionJournalRecord>();
  for (const record of input.records) {
    if (record.workspaceId !== context.scope.workspaceId) {
      foreign += 1;
      continue;
    }
    if (missing.has(record.eventId)) continue;
    if ((await readSuppressionEvent(context, record.eventId)) !== null) {
      alreadyPresent += 1;
      continue;
    }
    missing.set(record.eventId, record);
  }

  // J3 and J4 (RF reset): validity before selection. A release applies only when it carries
  // the `committed` marker every release written since the reset has (appended after its
  // commit); an unmarked one is reported, never applied. A correction whose original is
  // already decided `finalized` lost its claim live and never committed. Only what remains
  // competes in R2 below, so a stale candidate can never displace a valid one.
  const unverifiedLegacyReleases: string[] = [];
  const staleCorrections: string[] = [];
  for (const record of [...missing.values()]) {
    if (record.supersedesEventId === null) continue;
    if (record.committed !== true) {
      missing.delete(record.eventId);
      unverifiedLegacyReleases.push(record.eventId);
      continue;
    }
    if (record.source !== 'mistaken_entry_correction' || isMergeCopy(record)) continue;
    const decided = await readFinalization(context, record.supersedesEventId);
    const original = missing.get(record.supersedesEventId);
    const lost = decided !== null ? decided.outcome === 'finalized' : original !== undefined && TERMINAL_SOURCES.has(original.source);
    if (lost) {
      missing.delete(record.eventId);
      staleCorrections.push(record.eventId);
    }
  }

  // R2: at most one supersession lifts an event (0001's partial unique index). One the
  // database already holds wins; otherwise the earliest valid one by recorded time, then id.
  // The rest are the journal objects of a race's losers, and are counted, not inserted.
  const competingSupersessions: string[] = [];
  const bySuperseded = new Map<string, SuppressionJournalRecord[]>();
  for (const record of missing.values()) {
    if (record.supersedesEventId === null) continue;
    bySuperseded.set(record.supersedesEventId, [...(bySuperseded.get(record.supersedesEventId) ?? []), record]);
  }
  for (const [supersededId, rivals] of bySuperseded) {
    const { rows } = await context.db.query(
      'SELECT 1 FROM suppression_events WHERE workspace_id = $1 AND supersedes_event_id = $2 LIMIT 1',
      [context.scope.workspaceId, supersededId],
    );
    const ordered = [...rivals].sort(byRecordedTime);
    const losers = rows.length > 0 ? ordered : ordered.slice(1);
    for (const loser of losers) {
      missing.delete(loser.eventId);
      competingSupersessions.push(loser.eventId);
    }
  }

  // R3: an original before anything that supersedes it, whatever order the journal was
  // listed in; otherwise earliest first. The foreign key to the original is immediate.
  const ordered: SuppressionJournalRecord[] = [];
  const orphanSupersessions: string[] = [];
  const placed = new Set<string>();
  const place = async (record: SuppressionJournalRecord): Promise<boolean> => {
    if (placed.has(record.eventId)) return true;
    if (record.supersedesEventId !== null) {
      const original = missing.get(record.supersedesEventId);
      const present = original === undefined && (await readSuppressionEvent(context, record.supersedesEventId)) !== null;
      if (original !== undefined) {
        if (!(await place(original))) {
          orphanSupersessions.push(record.eventId);
          return false;
        }
      } else if (!present) {
        orphanSupersessions.push(record.eventId);
        return false;
      }
    }
    placed.add(record.eventId);
    ordered.push(record);
    return true;
  };
  for (const record of [...missing.values()].sort(byRecordedTime)) {
    if (!placed.has(record.eventId) && !orphanSupersessions.includes(record.eventId)) await place(record);
  }

  // An original a replayed correction takes back is decided by that correction's claim, as
  // it was live, never finalized ahead of it because its window has closed since.
  const correctedBy = new Map<string, string>();
  for (const record of ordered) {
    if (record.source === 'mistaken_entry_correction' && record.supersedesEventId !== null && !isMergeCopy(record)) {
      correctedBy.set(record.supersedesEventId, record.eventId);
    }
  }

  let inserted = 0;
  let finalized = 0;
  let windowsReopened = 0;
  let released = 0;
  const unreconstructedHolds: string[] = [];
  for (const record of ordered) {
    // A correction is a claim before it is a row, as it was live. A lost claim means the stop
    // was finalized instead: the correction did not commit, so it is not inserted (the row
    // alone would lift the stop) and releases nothing (review P1).
    if (record.source === 'mistaken_entry_correction' && record.supersedesEventId !== null && !isMergeCopy(record)) {
      const claim = await claimFinalization(context, {
        eventId: record.supersedesEventId,
        outcome: 'corrected',
        correctionEventId: record.eventId,
        ...(record.actorUserId === null ? {} : { decidedByUserId: record.actorUserId }),
      });
      if (!claim.won && claim.outcome !== 'corrected') {
        staleCorrections.push(record.eventId);
        continue;
      }
    }
    await context.db.query(
      `INSERT INTO suppression_events
         (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
          actor_user_id, command_id, recorded_at, supersedes_event_id, supersession_reason, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12)`,
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
        // The journalled channel; a record written before 0037 parses as `all`.
        record.channel,
      ],
    );
    inserted += 1;

    // A merge's copy was, live, the row and nothing else (J1, J2): no finalization claim, no
    // review hold, no finalizer, nothing released.
    if (isMergeCopy(record)) continue;

    if (SUPERSESSION_SOURCES.has(record.source) && record.supersedesEventId !== null) {
      // R4: a lift is replayed as the lift it was: it releases the original's review hold (a
      // correction has claimed its original above). It opens no hold and is owed no
      // finalizer: `finalize.ts` answers `not_applicable` for it.
      await releaseHoldsOfEvent(context, { sourceEventId: record.supersedesEventId, reasonCode: 'manual_suppression_review' });
      released += 1;
      continue;
    }

    const terminal = TERMINAL_SOURCES.has(record.source);
    const deadline = Date.parse(record.recordedAt) + MANUAL_SUPPRESSION_CORRECTION_SECONDS * 1000;
    if (terminal || deadline <= Date.parse(now)) {
      // Appendix G 30 and the drill's step 2: a prospect-originated opt-out is
      // terminal, and a manual suppression whose window expired before the failure
      // finalises terminally rather than reopening — unless a replayed correction took it
      // back inside its window, which decides it instead.
      if (correctedBy.has(record.eventId)) continue;
      await claimFinalization(context, { eventId: record.eventId, outcome: 'finalized' });
      finalized += 1;
      continue;
    }

    // Still inside the window. The row the correction claims against has to exist and
    // the finalizer has to be owed, or the suppression would sit unfinalized forever.
    // The hold is the one the live write opened (brief RF, X5): on the firm it named, which
    // is the key of a firm stop and, since RF, journalled for a handle stop. A handle stop
    // journalled before RF names no firm, and its live hold cannot be known.
    const holdFirm = record.scope === 'firm' ? record.canonicalKey : (record.firmId ?? null);
    // Review P3: a handle stop whose object predates RF says nothing about a firm. Its hold
    // is reported, not guessed.
    if (record.scope === 'handle' && record.firmId === undefined) unreconstructedHolds.push(record.eventId);
    if (holdFirm !== null) {
      await openHold(context, {
        scopeKind: 'firm',
        scopeKey: holdFirm,
        reasonCode: 'manual_suppression_review',
        // The set the original write opened (DESIGN-S3X §2.3a): the event's own channel.
        blockedActionKinds: reviewHoldBlocks(record.channel),
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

  return {
    inserted,
    alreadyPresent,
    foreign,
    finalized,
    windowsReopened,
    released,
    competingSupersessions,
    orphanSupersessions,
    staleCorrections,
    unreconstructedHolds,
    unverifiedLegacyReleases,
  };
}
