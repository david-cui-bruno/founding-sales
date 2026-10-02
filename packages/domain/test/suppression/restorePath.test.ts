import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { isMergeCopyId, mergeCopyId, recordAdminSupersession, recordSuppression } from '../../suppression/events.ts';
import {
  deterministicEventId,
  journalObjectBody,
  recordingSuppressionJournal,
  type SuppressionJournal,
  type SuppressionJournalRecord,
} from '../../suppression/journal.ts';
import { parseSuppressionJournalRecord, replaySuppressionJournal } from '../../suppression/replay.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { insertStop, seedChannelFirm, userContext, type ChannelFirm } from './support/channelWorld.ts';

/**
 * The stop restore path (brief RF): replay's competing supersessions (R2), a replayed lift
 * as a release (R4), the review hold a handle stop's replay owes (X5), a repeated command
 * across the 0037 boundary (X6), and a merge that keeps a lifted stop lifted (X7). R1 is
 * `apps/api/test/supersessionRace.test.ts` (RC1); R3 and the whole restore are
 * `replayRestore.test.ts` (RC2).
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
});

afterAll(async () => {
  await database.drop();
});

const restore = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'migration' }), database.session);
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

/** A firm stop as the journal holds it. */
function stopRecord(firm: ChannelFirm, source: string, recordedAt: string, extra: Partial<SuppressionJournalRecord> = {}): SuppressionJournalRecord {
  const commandId = randomUUID();
  return {
    eventId: deterministicEventId({ workspaceId: seeded.alpha.workspaceId, scope: 'firm', canonicalKey: firm.firmId, source, commandId }),
    workspaceId: seeded.alpha.workspaceId,
    scope: 'firm',
    canonicalKey: firm.firmId,
    canonicalizerVersion: 'e164-lower.1',
    source,
    actorUserId: source === 'salesperson_manual' ? seeded.alpha.salesperson.userId : null,
    commandId,
    supersedesEventId: null,
    supersessionReason: null,
    recordedAt,
    channel: 'all',
    ...extra,
  };
}

/** An admin supersession of `original`, as the journal holds it. */
function liftRecord(original: SuppressionJournalRecord, recordedAt: string): SuppressionJournalRecord {
  const commandId = randomUUID();
  return {
    ...original,
    eventId: deterministicEventId({
      workspaceId: original.workspaceId,
      scope: original.scope,
      canonicalKey: original.canonicalKey,
      source: 'admin_supersession',
      commandId,
      supersedesEventId: original.eventId,
      channel: original.channel,
    }),
    source: 'admin_supersession',
    actorUserId: seeded.alpha.admin.userId,
    commandId,
    supersedesEventId: original.eventId,
    supersessionReason: 'correction',
    recordedAt,
    // Journalled after its commit, as every release is since the RF reset (J2).
    committed: true,
  };
}

const supersessionsOf = async (eventId: string): Promise<readonly string[]> =>
  (
    await database.session.query<{ event_id: string }>(
      'SELECT event_id FROM suppression_events WHERE workspace_id = $1 AND supersedes_event_id = $2',
      [seeded.alpha.workspaceId, eventId],
    )
  ).rows.map(row => row.event_id);

const openReviewHolds = async (scopeKey: string): Promise<readonly { source_event_id: string; kinds: string[] }[]> =>
  (
    await database.session.query<{ source_event_id: string; kinds: string[] }>(
      `SELECT source_event_id, blocked_action_kinds AS kinds FROM active_holds
        WHERE workspace_id = $1 AND scope_key = $2 AND reason_code = 'manual_suppression_review' AND released_at IS NULL`,
      [seeded.alpha.workspaceId, scopeKey],
    )
  ).rows;

describe('R2: replay keeps one supersession per event', () => {
  it('keeps the earliest of two rivals, whatever the order they are read in, and reports the other by id', async () => {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    const stop = stopRecord(firm, 'prospect_do_not_call', minutesAgo(40));
    const earlier = liftRecord(stop, minutesAgo(30));
    const later = liftRecord(stop, minutesAgo(20));
    const report = await withTransaction(database.session, async () =>
      await replaySuppressionJournal(restore(), { records: [later, stop, earlier] }),
    );
    expect(await supersessionsOf(stop.eventId)).toEqual([earlier.eventId]);
    expect(report.competingSupersessions).toEqual([later.eventId]);
    expect(report.inserted).toBe(2);
  });

  it('leaves the supersession the database already holds, and skips a journalled rival', async () => {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    const stopId = await insertStop(database.session, seeded.alpha.workspaceId, {
      scope: 'firm',
      key: firm.firmId,
      channel: 'all',
      at: minutesAgo(40),
      source: 'prospect_do_not_call',
    });
    const kept = await insertStop(database.session, seeded.alpha.workspaceId, {
      scope: 'firm',
      key: firm.firmId,
      channel: 'all',
      at: minutesAgo(20),
      supersedes: stopId,
    });
    // The rival is earlier than the row the database holds; the row stays, being history.
    const stop = { ...stopRecord(firm, 'prospect_do_not_call', minutesAgo(40)), eventId: stopId };
    const rival = liftRecord(stop, minutesAgo(30));
    const report = await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [rival] }));
    expect(await supersessionsOf(stopId)).toEqual([kept]);
    expect(report).toMatchObject({ inserted: 0, competingSupersessions: [rival.eventId] });
  });
});

describe('R4: a replayed supersession is a release, never a manual stop', () => {
  it('opens no hold and owes no finalizer, and releases its original’s review hold', async () => {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    // A manual firm stop inside its window, still in the database with its review hold.
    const journal = recordingSuppressionJournal();
    const recorded = await withTransaction(database.session, async () =>
      await recordSuppression(userContext(database.session, seeded.alpha), {
        scope: 'firm',
        firmId: firm.firmId,
        source: 'salesperson_manual',
        channel: 'all',
        commandId: randomUUID(),
        journal,
      }),
    );
    if (!recorded.ok) throw new Error(recorded.reason);
    expect(await openReviewHolds(firm.firmId)).toHaveLength(1);
    // Its lift was lost with the restore and is in the journal, a minute old.
    const original = journal.appended[0]!;
    const lift = liftRecord(original, minutesAgo(1));
    const report = await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [lift] }));
    expect(report).toMatchObject({ inserted: 1, released: 1, windowsReopened: 0, finalized: 0 });
    expect(await openReviewHolds(firm.firmId)).toEqual([]);
    const jobs = await database.session.query(
      `SELECT 1 FROM jobs WHERE workspace_id = $1 AND kind = 'suppression.finalize' AND payload->>'eventId' = $2`,
      [seeded.alpha.workspaceId, lift.eventId],
    );
    expect(jobs.rows).toEqual([]);
  });
});

describe('X5: replay opens the review hold the live write opened for a handle stop', () => {
  it('journals the firm a manual handle stop was recorded with, and replays its hold on that firm', async () => {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    const journal = recordingSuppressionJournal();
    const value = '+14155550142';
    // Recorded, then lost with a restore to before it: the row and its hold are gone, the
    // journal object is not.
    await database.session.query('BEGIN');
    let live: Awaited<ReturnType<typeof openReviewHolds>>;
    try {
      const recorded = await recordSuppression(userContext(database.session, seeded.alpha), {
        scope: 'handle',
        value,
        firmId: firm.firmId,
        source: 'salesperson_manual',
        channel: 'phone',
        commandId: randomUUID(),
        journal,
      });
      if (!recorded.ok) throw new Error(recorded.reason);
      live = await openReviewHolds(firm.firmId);
    } finally {
      await database.session.query('ROLLBACK');
    }
    expect(live).toHaveLength(1);
    const record = journal.appended[0]!;
    // The firm travels in the object itself, so a replay from the bucket has it.
    expect(parseSuppressionJournalRecord(journalObjectBody(record))).toMatchObject({ ok: true, value: { firmId: firm.firmId } });
    await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [record] }));
    expect(await openReviewHolds(firm.firmId)).toEqual(live);
  });

  it('a handle stop journalled before RF names no firm, and replays with no hold, as before', async () => {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    const commandId = randomUUID();
    const record: SuppressionJournalRecord = {
      eventId: deterministicEventId({ workspaceId: seeded.alpha.workspaceId, scope: 'handle', canonicalKey: '+14155550143', source: 'salesperson_manual', commandId, channel: 'phone' }),
      workspaceId: seeded.alpha.workspaceId,
      scope: 'handle',
      canonicalKey: '+14155550143',
      canonicalizerVersion: 'e164-lower.1',
      source: 'salesperson_manual',
      actorUserId: seeded.alpha.salesperson.userId,
      commandId,
      supersedesEventId: null,
      supersessionReason: null,
      recordedAt: minutesAgo(1),
      channel: 'phone',
    };
    const body = JSON.parse(journalObjectBody(record)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('firmId');
    const report = await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [record] }));
    expect(report.windowsReopened).toBe(1);
    expect(await openReviewHolds(firm.firmId)).toEqual([]);
    // Review P3: not guessed, and not silent either.
    expect(report.unreconstructedHolds).toEqual([record.eventId]);
  });

  it('a handle stop journalled since RF with no firm says so, and is not reported', async () => {
    const commandId = randomUUID();
    const record: SuppressionJournalRecord = {
      eventId: deterministicEventId({ workspaceId: seeded.alpha.workspaceId, scope: 'handle', canonicalKey: '+14155550145', source: 'salesperson_manual', commandId, channel: 'phone' }),
      workspaceId: seeded.alpha.workspaceId,
      scope: 'handle',
      canonicalKey: '+14155550145',
      canonicalizerVersion: 'e164-lower.1',
      source: 'salesperson_manual',
      actorUserId: seeded.alpha.salesperson.userId,
      commandId,
      supersedesEventId: null,
      supersessionReason: null,
      recordedAt: minutesAgo(1),
      channel: 'phone',
      firmId: null,
    };
    const parsed = parseSuppressionJournalRecord(journalObjectBody(record));
    expect(parsed).toMatchObject({ ok: true, value: { firmId: null } });
    const report = await withTransaction(database.session, async () =>
      await replaySuppressionJournal(restore(), { records: [parsed.ok ? parsed.value : record] }),
    );
    expect(report).toMatchObject({ windowsReopened: 1, unreconstructedHolds: [] });
  });
});

describe('X6: the same command maps to the same stop across the 0037 boundary', () => {
  it('an opt-out journalled before 0037 as `all`, reprocessed as `email`, answers with that event and writes nothing', async () => {
    const address = `pat.${randomUUID().slice(0, 8)}@restore.example.test`;
    const commandId = `mail-message:${randomUUID()}:provider-${randomUUID().slice(0, 8)}`;
    // What step 2's replay put back: the pre-0037 event, id hashed without a channel.
    const before = deterministicEventId({ workspaceId: seeded.alpha.workspaceId, scope: 'handle', canonicalKey: address, source: 'prospect_opt_out', commandId });
    await database.session.query(
      `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, command_id, recorded_at)
       VALUES ($1, $2, 'handle', $3, 'e164-lower.1', 'prospect_opt_out', $4, $5)`,
      [seeded.alpha.workspaceId, before, address, commandId, minutesAgo(90)],
    );
    const journal = recordingSuppressionJournal();
    const again = await withTransaction(database.session, async () =>
      await recordSuppression(
        repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session),
        { scope: 'handle', value: address, source: 'prospect_opt_out', channel: 'email', commandId, journal },
      ),
    );
    expect(again).toMatchObject({ ok: true, value: { eventId: before, replayed: true, channel: 'all' } });
    expect(journal.appended).toEqual([]);
    const { rows } = await database.session.query('SELECT event_id FROM suppression_events WHERE workspace_id = $1 AND canonical_key = $2', [
      seeded.alpha.workspaceId,
      address,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('an earlier event that covers less is not the same fact: the wider stop is recorded beside it', async () => {
    const address = `sam.${randomUUID().slice(0, 8)}@restore.example.test`;
    const commandId = `cmd-${randomUUID()}`;
    const system = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);
    const journal = recordingSuppressionJournal();
    const email = await withTransaction(database.session, async () =>
      await recordSuppression(system, { scope: 'handle', value: address, source: 'prospect_opt_out', channel: 'email', commandId, journal }),
    );
    const all = await withTransaction(database.session, async () =>
      await recordSuppression(system, { scope: 'handle', value: address, source: 'prospect_opt_out', channel: 'all', commandId, journal }),
    );
    expect(email.ok && all.ok).toBe(true);
    if (email.ok && all.ok) {
      expect(all.value.eventId).not.toBe(email.value.eventId);
      expect(all.value.replayed).toBe(false);
    }
  });
});

describe('X7: a merge keeps a lifted stop lifted and an active stop active', () => {
  it('copies the lift with the stop it lifted, and nothing turns active or lifted on the target', async () => {
    const source = await seedChannelFirm(database.session, seeded.alpha);
    const target = await seedChannelFirm(database.session, seeded.alpha);
    const journal = recordingSuppressionJournal();
    const record = async (channel: 'phone' | 'email'): Promise<string> => {
      const recorded = await withTransaction(database.session, async () =>
        await recordSuppression(userContext(database.session, seeded.alpha), {
          scope: 'firm',
          firmId: source.firmId,
          source: channel === 'phone' ? 'prospect_do_not_call' : 'prospect_opt_out',
          channel,
          commandId: randomUUID(),
          journal,
        }),
      );
      if (!recorded.ok) throw new Error(recorded.reason);
      return recorded.value.eventId;
    };
    const lifted = await record('phone');
    const active = await record('email');
    const lift = await withTransaction(database.session, async () =>
      await recordAdminSupersession(userContext(database.session, seeded.alpha, 'admin'), {
        eventId: lifted,
        reason: 'documented_reconsent',
        commandId: randomUUID(),
      }),
    );
    expect(lift.ok, JSON.stringify(lift)).toBe(true);

    const merged = await withTransaction(database.session, async () =>
      await mergeFirms(userContext(database.session, seeded.alpha, 'admin'), { journal: recordingSuppressionJournal(), sourceFirmId: source.firmId, targetFirmId: target.firmId }),
    );
    expect(merged.ok, JSON.stringify(merged)).toBe(true);

    const effective = await database.session.query<{ event_id: string; channel: string }>(
      `SELECT event_id, channel FROM effective_suppressions WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = $2`,
      [seeded.alpha.workspaceId, target.firmId],
    );
    expect(effective.rows).toEqual([{ event_id: `mergecopy:${active}@${target.firmId}`, channel: 'email' }]);
    expect(await supersessionsOf(`mergecopy:${lifted}@${target.firmId}`)).toEqual([`mergecopy:${lift.ok ? lift.value.supersessionEventId : ''}@${target.firmId}`]);
    expect(await supersessionsOf(`mergecopy:${active}@${target.firmId}`)).toEqual([]);
  });
});

describe('R3: a supersession with no original anywhere', () => {
  it('is skipped and reported, and releases nothing', async () => {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    // A manual stop with its open review hold, in the database; an orphan lift names a stop
    // that is neither there nor in the records read.
    const journal = recordingSuppressionJournal();
    const recorded = await withTransaction(database.session, async () =>
      await recordSuppression(userContext(database.session, seeded.alpha), {
        scope: 'firm',
        firmId: firm.firmId,
        source: 'salesperson_manual',
        channel: 'all',
        commandId: randomUUID(),
        journal,
      }),
    );
    if (!recorded.ok) throw new Error(recorded.reason);
    const missing = stopRecord(firm, 'salesperson_manual', minutesAgo(5));
    const orphan = liftRecord(missing, minutesAgo(4));
    const report = await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [orphan] }));
    expect(report).toMatchObject({ inserted: 0, released: 0, orphanSupersessions: [orphan.eventId] });
    expect(await supersessionsOf(missing.eventId)).toEqual([]);
    // The stop in the database still holds the firm.
    expect(await openReviewHolds(firm.firmId)).toHaveLength(1);
  });
});

describe('R4 and review P1: a replayed correction', () => {
  /** A correction of `original`, as the journal holds it. */
  function correctionRecord(original: SuppressionJournalRecord, recordedAt: string): SuppressionJournalRecord {
    const commandId = randomUUID();
    return {
      ...original,
      eventId: deterministicEventId({
        workspaceId: original.workspaceId,
        scope: original.scope,
        canonicalKey: original.canonicalKey,
        source: 'mistaken_entry_correction',
        commandId,
        supersedesEventId: original.eventId,
        channel: original.channel,
      }),
      source: 'mistaken_entry_correction',
      commandId,
      supersedesEventId: original.eventId,
      supersessionReason: 'mistaken_entry',
      recordedAt,
      committed: true,
    };
  }

  it('is a release: it claims its original corrected, releases its hold, and opens nothing', async () => {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    const stop = stopRecord(firm, 'salesperson_manual', minutesAgo(3), { firmId: firm.firmId });
    const correction = correctionRecord(stop, minutesAgo(2));
    const report = await withTransaction(database.session, async () =>
      await replaySuppressionJournal(restore(), { records: [correction, stop] }),
    );
    expect(report).toMatchObject({ inserted: 2, released: 1, windowsReopened: 1, staleCorrections: [] });
    expect(await supersessionsOf(stop.eventId)).toEqual([correction.eventId]);
    expect(await openReviewHolds(firm.firmId)).toEqual([]);
    const claim = await database.session.query<{ outcome: string; correction_event_id: string }>(
      'SELECT outcome, correction_event_id FROM suppression_finalizations WHERE workspace_id = $1 AND event_id = $2',
      [seeded.alpha.workspaceId, stop.eventId],
    );
    expect(claim.rows).toEqual([{ outcome: 'corrected', correction_event_id: correction.eventId }]);
    const jobs = await database.session.query(
      `SELECT 1 FROM jobs WHERE workspace_id = $1 AND kind = 'suppression.finalize' AND payload->>'eventId' = $2`,
      [seeded.alpha.workspaceId, correction.eventId],
    );
    expect(jobs.rows).toEqual([]);
  });

  it('whose stop was finalized instead is not inserted and releases nothing (the legacy failed correction)', async () => {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    // Live: the stop, its correction rolled back after its journal write (before RF), and the
    // finalizer then finalized the stop. The database has the stop and its claim.
    const journal = recordingSuppressionJournal();
    const recorded = await withTransaction(database.session, async () =>
      await recordSuppression(userContext(database.session, seeded.alpha), {
        scope: 'firm',
        firmId: firm.firmId,
        source: 'salesperson_manual',
        channel: 'all',
        commandId: randomUUID(),
        journal,
      }),
    );
    if (!recorded.ok) throw new Error(recorded.reason);
    await database.session.query(
      `INSERT INTO suppression_finalizations (workspace_id, event_id, outcome) VALUES ($1, $2, 'finalized')`,
      [seeded.alpha.workspaceId, recorded.value.eventId],
    );
    const stale = correctionRecord(journal.appended[0]!, minutesAgo(1));
    const report = await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [stale] }));
    expect(report).toMatchObject({ inserted: 0, released: 0, staleCorrections: [stale.eventId] });
    expect(await supersessionsOf(recorded.value.eventId)).toEqual([]);
    // Still a stop, and its review hold is not released by the stale correction.
    const effective = await database.session.query('SELECT 1 FROM effective_suppressions WHERE workspace_id = $1 AND event_id = $2', [
      seeded.alpha.workspaceId,
      recorded.value.eventId,
    ]);
    expect(effective.rows).toHaveLength(1);
    expect(await openReviewHolds(firm.firmId)).toHaveLength(1);
  });
});

describe('RF reset J3: an unmarked (legacy) release is never applied', () => {
  it('a correction journalled before the reset is reported and leaves the stop and its hold', async () => {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    const journal = recordingSuppressionJournal();
    const recorded = await withTransaction(database.session, async () =>
      await recordSuppression(userContext(database.session, seeded.alpha), {
        scope: 'firm',
        firmId: firm.firmId,
        source: 'salesperson_manual',
        channel: 'all',
        commandId: randomUUID(),
        journal,
      }),
    );
    if (!recorded.ok) throw new Error(recorded.reason);
    // Written before the reset, inside a transaction that may have rolled back: no marker.
    const { committed: _marker, ...legacy } = {
      ...liftRecord(journal.appended[0]!, minutesAgo(0.5)),
      source: 'mistaken_entry_correction',
      supersessionReason: 'mistaken_entry',
    };
    const report = await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [legacy] }));
    expect(report).toMatchObject({ inserted: 0, released: 0, unverifiedLegacyReleases: [legacy.eventId] });
    expect(await supersessionsOf(recorded.value.eventId)).toEqual([]);
    expect(await openReviewHolds(firm.firmId)).toHaveLength(1);
  });
});

describe('RF reset J4: validity before selection', () => {
  it('a stale correction and a later committed admin lift: the admin lift applies', async () => {
    for (const marked of [true, false]) {
      const firm = await seedChannelFirm(database.session, seeded.alpha);
      const journal = recordingSuppressionJournal();
      const recorded = await withTransaction(database.session, async () =>
        await recordSuppression(userContext(database.session, seeded.alpha), {
          scope: 'firm',
          firmId: firm.firmId,
          source: 'salesperson_manual',
          channel: 'all',
          commandId: randomUUID(),
          journal,
        }),
      );
      if (!recorded.ok) throw new Error(recorded.reason);
      // The restored database kept the stop and its finalization, and neither release.
      await database.session.query(`INSERT INTO suppression_finalizations (workspace_id, event_id, outcome) VALUES ($1, $2, 'finalized')`, [
        seeded.alpha.workspaceId,
        recorded.value.eventId,
      ]);
      const original = journal.appended[0]!;
      const correction = { ...liftRecord(original, minutesAgo(9)), source: 'mistaken_entry_correction', supersessionReason: 'mistaken_entry' };
      const { committed: _marker, ...unmarked } = correction;
      const stale = marked ? correction : unmarked;
      const lift = liftRecord(original, minutesAgo(1));
      const report = await withTransaction(database.session, async () =>
        await replaySuppressionJournal(restore(), { records: [lift, stale] }),
      );
      expect(await supersessionsOf(recorded.value.eventId), String(marked)).toEqual([lift.eventId]);
      expect(report.competingSupersessions, String(marked)).toEqual([]);
      if (marked) expect(report.staleCorrections).toEqual([stale.eventId]);
      else expect(report.unverifiedLegacyReleases).toEqual([stale.eventId]);
    }
  });
});

describe('RF reset J1 and J2: a merge’s copies survive a restore', () => {
  async function stoppedPair(journal: ReturnType<typeof recordingSuppressionJournal>): Promise<{ source: ChannelFirm; target: ChannelFirm; stopId: string }> {
    const source = await seedChannelFirm(database.session, seeded.alpha);
    const target = await seedChannelFirm(database.session, seeded.alpha);
    const recorded = await withTransaction(database.session, async () =>
      await recordSuppression(userContext(database.session, seeded.alpha), {
        scope: 'firm',
        firmId: source.firmId,
        source: 'prospect_do_not_call',
        channel: 'all',
        commandId: randomUUID(),
        journal,
      }),
    );
    if (!recorded.ok) throw new Error(recorded.reason);
    const merged = await withTransaction(database.session, async () =>
      await mergeFirms(userContext(database.session, seeded.alpha, 'admin'), { journal, sourceFirmId: source.firmId, targetFirmId: target.firmId }),
    );
    expect(merged.ok, JSON.stringify(merged)).toBe(true);
    return { source, target, stopId: recorded.value.eventId };
  }
  const effectiveOn = async (firmId: string): Promise<readonly string[]> =>
    (
      await database.session.query<{ event_id: string }>(
        `SELECT event_id FROM effective_suppressions WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = $2`,
        [seeded.alpha.workspaceId, firmId],
      )
    ).rows.map(row => row.event_id);
  const remove = async (eventIds: readonly string[]): Promise<void> => {
    await database.session.query('DELETE FROM suppression_events WHERE workspace_id = $1 AND event_id = ANY($2::text[])', [
      seeded.alpha.workspaceId,
      eventIds,
    ]);
  };

  it('a restore to before the merge: replay gives the survivor back the stop it inherited', async () => {
    const journal = recordingSuppressionJournal();
    const { target, stopId } = await stoppedPair(journal);
    // The copy was journalled before the merge committed, with the survivor's key.
    expect(journal.appended.map(record => [record.eventId, record.canonicalKey])).toContainEqual([`mergecopy:${stopId}@${target.firmId}`, target.firmId]);
    await remove([`mergecopy:${stopId}@${target.firmId}`]);
    expect(await effectiveOn(target.firmId)).toEqual([]);
    await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: journal.appended }));
    expect(await effectiveOn(target.firmId)).toEqual([`mergecopy:${stopId}@${target.firmId}`]);
    // Live, a copy is the row alone: no finalization claim.
    const claims = await database.session.query('SELECT 1 FROM suppression_finalizations WHERE workspace_id = $1 AND event_id = $2', [
      seeded.alpha.workspaceId,
      `mergecopy:${stopId}@${target.firmId}`,
    ]);
    expect(claims.rows).toEqual([]);
  });

  it('a restore between the merge and a lift of the original: replay lifts the copy too', async () => {
    const journal = recordingSuppressionJournal();
    const { source, target, stopId } = await stoppedPair(journal);
    const lifted = await withTransaction(database.session, async () =>
      await recordAdminSupersession(userContext(database.session, seeded.alpha, 'admin'), {
        eventId: stopId,
        reason: 'documented_reconsent',
        commandId: randomUUID(),
      }),
    );
    if (!lifted.ok) throw new Error(lifted.reason);
    // The lift and its copy, journalled after the commit and marked, as the route does.
    expect(lifted.value.journalRecords.map(record => record.supersedesEventId)).toEqual([stopId, `mergecopy:${stopId}@${target.firmId}`]);
    for (const record of lifted.value.journalRecords) await journal.append({ ...record, committed: true });
    await remove(lifted.value.journalRecords.map(record => record.eventId));
    expect(await effectiveOn(target.firmId)).toEqual([`mergecopy:${stopId}@${target.firmId}`]);
    await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: journal.appended }));
    expect(await effectiveOn(target.firmId)).toEqual([]);
    expect(await effectiveOn(source.firmId)).toEqual([]);
  });
});

describe('review RFR: a merge copy is per survivor', () => {
  /** The S3 journal's conditional put: the first object at a key is kept; a second is "already present". */
  function conditionalJournal(): SuppressionJournal & { readonly objects: Map<string, SuppressionJournalRecord> } {
    const objects = new Map<string, SuppressionJournalRecord>();
    return {
      objects,
      async append(record: SuppressionJournalRecord): Promise<void> {
        if (!objects.has(record.eventId)) objects.set(record.eventId, record);
        await Promise.resolve();
      },
    };
  }

  async function stoppedFirm(journal: SuppressionJournal): Promise<{ firm: ChannelFirm; stopId: string }> {
    const firm = await seedChannelFirm(database.session, seeded.alpha);
    const recorded = await withTransaction(database.session, async () =>
      await recordSuppression(userContext(database.session, seeded.alpha), {
        scope: 'firm',
        firmId: firm.firmId,
        source: 'prospect_do_not_call',
        channel: 'all',
        commandId: randomUUID(),
        journal,
      }),
    );
    if (!recorded.ok) throw new Error(recorded.reason);
    return { firm, stopId: recorded.value.eventId };
  }

  /** A merge that journals its copies and then rolls back, as a failed commit would. */
  async function rolledBackMerge(journal: SuppressionJournal, sourceFirmId: string, targetFirmId: string): Promise<void> {
    await database.session.query('BEGIN');
    try {
      const merged = await mergeFirms(userContext(database.session, seeded.alpha, 'admin'), { journal, sourceFirmId, targetFirmId });
      expect(merged.ok, JSON.stringify(merged)).toBe(true);
    } finally {
      await database.session.query('ROLLBACK');
    }
  }

  async function merge(journal: SuppressionJournal, sourceFirmId: string, targetFirmId: string): Promise<void> {
    const merged = await withTransaction(database.session, async () =>
      await mergeFirms(userContext(database.session, seeded.alpha, 'admin'), { journal, sourceFirmId, targetFirmId }),
    );
    expect(merged.ok, JSON.stringify(merged)).toBe(true);
  }

  const stoppedOn = async (firmId: string): Promise<boolean> =>
    (
      await database.session.query(`SELECT 1 FROM effective_suppressions WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = $2`, [
        seeded.alpha.workspaceId,
        firmId,
      ])
    ).rows.length > 0;

  it('A→B rolls back after journalling, A→C commits: a restore before A→C still gives C its stop', async () => {
    const journal = conditionalJournal();
    const { firm: a, stopId } = await stoppedFirm(journal);
    const b = await seedChannelFirm(database.session, seeded.alpha);
    const c = await seedChannelFirm(database.session, seeded.alpha);
    await rolledBackMerge(journal, a.firmId, b.firmId);
    await merge(journal, a.firmId, c.firmId);
    expect(await stoppedOn(c.firmId)).toBe(true);
    // C's copy has its own durable object, not B's.
    expect(journal.objects.get(mergeCopyId(stopId, c.firmId))).toMatchObject({ canonicalKey: c.firmId });
    // A restore to before A→C.
    await database.session.query('DELETE FROM suppression_events WHERE workspace_id = $1 AND event_id = $2', [
      seeded.alpha.workspaceId,
      mergeCopyId(stopId, c.firmId),
    ]);
    expect(await stoppedOn(c.firmId)).toBe(false);
    await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [...journal.objects.values()] }));
    expect(await stoppedOn(c.firmId)).toBe(true);
  });

  it('a replay that finds B’s copy restored first still inserts C’s', async () => {
    const journal = recordingSuppressionJournal();
    const { firm: a, stopId } = await stoppedFirm(journal);
    const b = await seedChannelFirm(database.session, seeded.alpha);
    const c = await seedChannelFirm(database.session, seeded.alpha);
    await rolledBackMerge(journal, a.firmId, b.firmId);
    await merge(journal, a.firmId, c.firmId);
    const copies = journal.appended.filter(record => isMergeCopyId(record.eventId));
    const forB = copies.find(record => record.canonicalKey === b.firmId)!;
    const forC = copies.find(record => record.canonicalKey === c.firmId)!;
    expect(forB.eventId).not.toBe(forC.eventId);
    // The database has B's copy (restored first) and has lost C's.
    await database.session.query('DELETE FROM suppression_events WHERE workspace_id = $1 AND event_id = $2', [seeded.alpha.workspaceId, forC.eventId]);
    await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [forB] }));
    expect(await stoppedOn(b.firmId)).toBe(true);
    const report = await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records: [forB, forC] }));
    expect(report).toMatchObject({ inserted: 1, alreadyPresent: 1 });
    expect(await stoppedOn(c.firmId)).toBe(true);
    void stopId;
  });

  it('a retry of the same A→B merge reaches the same copy id and the same journal object', async () => {
    const journal = conditionalJournal();
    const { firm: a, stopId } = await stoppedFirm(journal);
    const b = await seedChannelFirm(database.session, seeded.alpha);
    await rolledBackMerge(journal, a.firmId, b.firmId);
    expect([...journal.objects.keys()]).toContain(mergeCopyId(stopId, b.firmId));
    const before = journal.objects.size;
    await merge(journal, a.firmId, b.firmId);
    expect(journal.objects.size).toBe(before);
    const { rows } = await database.session.query<{ event_id: string }>(
      `SELECT event_id FROM suppression_events WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = $2`,
      [seeded.alpha.workspaceId, b.firmId],
    );
    expect(rows.map(row => row.event_id)).toEqual([`mergecopy:${stopId}@${b.firmId}`]);
  });

  describe('review RFV: the two copy forms never collide', () => {
    /** A copy as a merge before RF's last repair journalled and wrote it: `merge:<event>`. */
    const legacyCopy = (stop: SuppressionJournalRecord, firmId: string): SuppressionJournalRecord => ({
      ...stop,
      eventId: `merge:${stop.eventId}`,
      canonicalKey: firmId,
    });
    const copyOf = (parent: SuppressionJournalRecord, firmId: string): SuppressionJournalRecord => ({
      ...parent,
      eventId: mergeCopyId(parent.eventId, firmId),
      canonicalKey: firmId,
    });
    const replayed = async (records: readonly SuppressionJournalRecord[]) =>
      await withTransaction(database.session, async () => await replaySuppressionJournal(restore(), { records }));
    const lift = async (eventId: string): Promise<readonly SuppressionJournalRecord[]> => {
      const lifted = await withTransaction(database.session, async () =>
        await recordAdminSupersession(userContext(database.session, seeded.alpha, 'admin'), {
          eventId,
          reason: 'documented_reconsent',
          commandId: randomUUID(),
        }),
      );
      if (!lifted.ok) throw new Error(lifted.reason);
      return lifted.value.journalRecords;
    };
    /** Every stop on the firm that nothing lifted (the view shows one per channel). */
    const effectiveIds = async (firmId: string): Promise<readonly string[]> =>
      (
        await database.session.query<{ event_id: string }>(
          `SELECT e.event_id FROM suppression_events e
            WHERE e.workspace_id = $1 AND e.scope = 'firm' AND e.canonical_key = $2 AND e.supersedes_event_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM suppression_events s WHERE s.workspace_id = e.workspace_id AND s.supersedes_event_id = e.event_id)`,
          [seeded.alpha.workspaceId, firmId],
        )
      ).rows
        .map(row => row.event_id)
        .sort();

    it('the reviewer’s sequence: lifting a restored A→C copy leaves the legacy branch’s stop on D', async () => {
      const journal = conditionalJournal();
      const { firm: a, stopId } = await stoppedFirm(journal);
      const [b, c, d] = [
        await seedChannelFirm(database.session, seeded.alpha),
        await seedChannelFirm(database.session, seeded.alpha),
        await seedChannelFirm(database.session, seeded.alpha),
      ];
      // A pre-repair A→B failed and was replayed: A keeps its stop, B has the legacy copy.
      await replayed([legacyCopy(journal.objects.get(stopId)!, b.firmId)]);
      // A post-repair A→C journals C's copy and rolls back.
      await rolledBackMerge(journal, a.firmId, c.firmId);
      // B→C, then C→D: D inherits only the legacy branch.
      await merge(journal, b.firmId, c.firmId);
      await merge(journal, c.firmId, d.firmId);
      const onC = mergeCopyId(`merge:${stopId}`, c.firmId);
      const onD = mergeCopyId(onC, d.firmId);
      expect(await effectiveIds(d.firmId)).toEqual([onD]);
      // A restore replays the journal: C's A→C copy comes back.
      await replayed([...journal.objects.values()]);
      const restoredCopy = mergeCopyId(stopId, c.firmId);
      expect(await effectiveIds(c.firmId)).toContain(restoredCopy);
      // Lifting it lifts that branch alone.
      const lifts = await lift(restoredCopy);
      expect(lifts.map(record => record.supersedesEventId)).toEqual([restoredCopy]);
      expect(await effectiveIds(d.firmId)).toEqual([onD]);
      expect(await effectiveIds(c.firmId)).toEqual([onC]);
    });

    it('a new copy of a legacy copy is not a child of the new copy of the original: lifting the second leaves the first', async () => {
      const journal = conditionalJournal();
      const { stopId } = await stoppedFirm(journal);
      const [b, c] = [await seedChannelFirm(database.session, seeded.alpha), await seedChannelFirm(database.session, seeded.alpha)];
      const stop = journal.objects.get(stopId)!;
      const onB = legacyCopy(stop, b.firmId);
      // On C: B's legacy copy merged on (B→C), and the original copied directly (A→C).
      const legacyBranch = copyOf(onB, c.firmId);
      const direct = copyOf(stop, c.firmId);
      await replayed([onB, legacyBranch, direct]);
      expect(await effectiveIds(c.firmId)).toEqual([legacyBranch.eventId, direct.eventId].sort());
      const lifts = await lift(direct.eventId);
      expect(lifts.map(record => record.supersedesEventId)).toEqual([direct.eventId]);
      expect(await effectiveIds(c.firmId)).toEqual([legacyBranch.eventId]);
      expect(await effectiveIds(b.firmId)).toEqual([onB.eventId]);
    });

    it('lifting a legacy copy lifts its own copies in their own forms, never the original’s new copy; a restore replays them as copies', async () => {
      const journal = conditionalJournal();
      const { stopId } = await stoppedFirm(journal);
      const [b, c, e] = [
        await seedChannelFirm(database.session, seeded.alpha),
        await seedChannelFirm(database.session, seeded.alpha),
        await seedChannelFirm(database.session, seeded.alpha),
      ];
      const stop = journal.objects.get(stopId)!;
      const onB = legacyCopy(stop, b.firmId);
      // A pre-repair copy of B's copy (legacy form), a post-repair one (new form), and the
      // original's own new copy on C.
      const legacyChild = legacyCopy(onB, e.firmId);
      const newChild = copyOf(onB, c.firmId);
      const sibling = copyOf(stop, c.firmId);
      // The forms are told apart by prefix (review RFV): a copy is never `merge:` anything.
      expect([newChild.eventId, sibling.eventId]).toEqual([`mergecopy:merge:${stopId}@${c.firmId}`, `mergecopy:${stopId}@${c.firmId}`]);
      await replayed([onB, legacyChild, newChild, sibling]);
      const lifts = await lift(onB.eventId);
      const liftId = lifts[0]!.eventId;
      expect(lifts[0]!.supersedesEventId).toBe(onB.eventId);
      expect(lifts.slice(1).map(record => [record.eventId, record.supersedesEventId]).sort()).toEqual(
        [
          [`merge:${liftId}`, legacyChild.eventId],
          [`mergecopy:${liftId}@${c.firmId}`, newChild.eventId],
        ].sort(),
      );
      expect(await effectiveIds(c.firmId)).toEqual([sibling.eventId]);
      expect(await effectiveIds(e.firmId)).toEqual([]);
      // A restore to before the lift: the marked releases replay; the copied lifts, in both
      // forms, are bare rows (no release of their own), the lift itself is a release.
      await database.session.query('DELETE FROM suppression_events WHERE workspace_id = $1 AND event_id = ANY($2::text[])', [
        seeded.alpha.workspaceId,
        lifts.map(record => record.eventId),
      ]);
      const report = await replayed(lifts.map(record => ({ ...record, committed: true as const })));
      expect(report).toMatchObject({ inserted: 3, released: 1 });
      expect(await effectiveIds(c.firmId)).toEqual([sibling.eventId]);
      expect(await effectiveIds(b.firmId)).toEqual([]);
      expect(await effectiveIds(e.firmId)).toEqual([]);
    });
  });
});
