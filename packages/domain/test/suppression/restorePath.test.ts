import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { recordAdminSupersession, recordSuppression } from '../../suppression/events.ts';
import {
  deterministicEventId,
  journalObjectBody,
  recordingSuppressionJournal,
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
        journal,
      }),
    );
    expect(lift.ok, JSON.stringify(lift)).toBe(true);

    const merged = await withTransaction(database.session, async () =>
      await mergeFirms(userContext(database.session, seeded.alpha, 'admin'), { sourceFirmId: source.firmId, targetFirmId: target.firmId }),
    );
    expect(merged.ok, JSON.stringify(merged)).toBe(true);

    const effective = await database.session.query<{ event_id: string; channel: string }>(
      `SELECT event_id, channel FROM effective_suppressions WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = $2`,
      [seeded.alpha.workspaceId, target.firmId],
    );
    expect(effective.rows).toEqual([{ event_id: `merge:${active}`, channel: 'email' }]);
    expect(await supersessionsOf(`merge:${lifted}`)).toEqual([`merge:${lift.ok ? lift.value.supersessionEventId : ''}`]);
    expect(await supersessionsOf(`merge:${active}`)).toEqual([]);
  });
});
