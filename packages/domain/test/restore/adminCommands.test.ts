import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { listHoldsByReason, openHold, releaseHold } from '../../policy/holds.ts';
import { ALL_BLOCKED_ACTION_KINDS } from '../../policy/types.ts';
import { deterministicEventId } from '../../suppression/journal.ts';
import { parseSuppressionJournalRecord, replaySuppressionJournal } from '../../suppression/replay.ts';
import { listOpenHolds } from '../../restore/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm } from '../db/support/crmFixtures.ts';
import { seedMail } from '../db/support/mailFixtures.ts';
import { seedOutbound } from '../db/support/outboundFixtures.ts';

/**
 * The two database operations `fss admin` keeps from the restore protocol: the hold
 * listing, and the suppression-journal replay the restore runbook runs against a
 * point-in-time copy (`docs/greenfield/runbooks/restore.md`).
 *
 * Both workspaces are seeded, and every read is checked per workspace, so a query that lost
 * its `workspace_id` shows up as a crossing rather than as a plausible number.
 */

const MIGRATION_SCOPE = { kind: 'system', component: 'migration' } as const;

interface World {
  readonly database: TestDatabase;
  readonly session: SessionQueryable;
  readonly workspaces: TwoWorkspaces;
}

let world: World;

/** One prospect opt-out per workspace, already in the database: the replay must see it as present. */
async function seedOptOuts(session: SessionQueryable, workspaces: TwoWorkspaces): Promise<void> {
  for (const [name, workspace] of [['alpha', workspaces.alpha], ['beta', workspaces.beta]] as const) {
    const eventId = deterministicEventId({
      workspaceId: workspace.workspaceId,
      scope: 'handle',
      canonicalKey: `opt-out-${name}@example.test`,
      source: 'prospect_opt_out',
      commandId: workspaces.collidingCommandId,
    });
    await session.query(
      `INSERT INTO suppression_events
         (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, recorded_at)
       VALUES ($1, $2, 'handle', $3, 'handle.1', 'prospect_opt_out', TIMESTAMPTZ '2026-09-02T12:00:00Z')`,
      [workspace.workspaceId, eventId, `opt-out-${name}@example.test`],
    );
  }
}

beforeAll(async () => {
  const database = await createTestDatabase();
  const { session } = database;
  const workspaces = await seedTwoWorkspaces(session);
  const crm = await seedCrm(session, workspaces);
  const mail = await seedMail(session, workspaces, crm);
  await seedOutbound(session, workspaces, crm, mail);
  await seedOptOuts(session, workspaces);
  world = { database, session, workspaces };
});

afterAll(async () => {
  await world.database.drop();
});

describe('fss admin holds list', () => {
  it('lists by reason across workspaces, and excludes by reason, without crossing', async () => {
    const alpha = repositoryContext(workspaceScope(world.workspaces.alpha.workspaceId, MIGRATION_SCOPE), world.session);
    const beta = repositoryContext(workspaceScope(world.workspaces.beta.workspaceId, MIGRATION_SCOPE), world.session);
    await openHold(alpha, {
      scopeKind: 'workspace',
      reasonCode: 'long_hold_review',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: 'test.long_hold',
    });
    await openHold(beta, {
      scopeKind: 'workspace',
      reasonCode: 'scoped_pause',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: 'admin.pause',
    });

    const review = await listOpenHolds(world.session, { reason: 'long_hold_review' });
    expect(review).toHaveLength(1);
    expect(review[0]?.workspaceId).toBe(world.workspaces.alpha.workspaceId);

    const others = await listOpenHolds(world.session, { excludeReason: 'long_hold_review' });
    // The mail fixture opens a hold of its own in each workspace, so "everything else"
    // is more than the pause; what matters is that the excluded hold is not in it.
    expect(others.every(hold => hold.reasonCode !== 'long_hold_review')).toBe(true);
    expect(others.some(hold => hold.reasonCode === 'scoped_pause')).toBe(true);

    // The scoped read the release path uses answers only for its own workspace.
    expect(await listHoldsByReason(alpha, { reason: 'scoped_pause' })).toHaveLength(0);
    expect(await listHoldsByReason(beta, { reason: 'scoped_pause' })).toHaveLength(1);
  });
});

describe('releaseHold with a reason (holds release-restore; lane W3-S8 review)', () => {
  it('releases only a hold that still has that reason, in the UPDATE itself', async () => {
    const alpha = repositoryContext(workspaceScope(world.workspaces.alpha.workspaceId, MIGRATION_SCOPE), world.session);
    const hold = await openHold(alpha, {
      scopeKind: 'workspace',
      reasonCode: 'long_hold_review',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: 'test.reason_guard',
    });
    // Read as a restore hold a moment ago, changed since: not released.
    expect(await releaseHold(alpha, hold, 'restore_in_progress')).toBeNull();
    const open = await world.session.query<{ released_at: Date | null }>(
      'SELECT released_at FROM active_holds WHERE workspace_id = $1 AND id = $2',
      [world.workspaces.alpha.workspaceId, hold],
    );
    expect(open.rows[0]?.released_at).toBeNull();
    // With its own reason, or none, it is released once.
    expect(await releaseHold(alpha, hold, 'long_hold_review')).toMatchObject({ id: hold });
    expect(await releaseHold(alpha, hold)).toBeNull();
  });
});

describe('fss admin suppression-journal replay', () => {
  it('parses a journalled record and refuses one that is not a suppression record', () => {
    const body = JSON.stringify({
      schema: 'fss.suppression.v1',
      eventId: 'sup_abc',
      workspaceId: world.workspaces.alpha.workspaceId,
      scope: 'handle',
      canonicalKey: 'replay@example.test',
      canonicalizerVersion: 'handle.1',
      source: 'prospect_opt_out',
      actorUserId: null,
      commandId: null,
      supersedesEventId: null,
      supersessionReason: null,
      recordedAt: '2026-09-02T12:30:00.000Z',
    });
    expect(parseSuppressionJournalRecord(body)).toMatchObject({ ok: true });
    expect(parseSuppressionJournalRecord('{"schema":"something.else"}')).toMatchObject({
      ok: false,
      reason: 'schema_unknown',
    });
    expect(parseSuppressionJournalRecord('not json')).toMatchObject({ ok: false, reason: 'not_json' });
  });

  it('inserts the missing event once and nothing the second time (deterministic ids)', async () => {
    const context = repositoryContext(
      workspaceScope(world.workspaces.alpha.workspaceId, MIGRATION_SCOPE),
      world.session,
    );
    const present = deterministicEventId({
      workspaceId: world.workspaces.alpha.workspaceId,
      scope: 'handle',
      canonicalKey: 'opt-out-alpha@example.test',
      source: 'prospect_opt_out',
      commandId: world.workspaces.collidingCommandId,
    });
    const records = [
      {
        eventId: present,
        workspaceId: world.workspaces.alpha.workspaceId,
        scope: 'handle' as const,
        canonicalKey: 'opt-out-alpha@example.test',
        canonicalizerVersion: 'handle.1',
        source: 'prospect_opt_out',
        actorUserId: null,
        commandId: world.workspaces.collidingCommandId,
        supersedesEventId: null,
        supersessionReason: null,
        recordedAt: '2026-09-02T12:00:00.000Z',
      },
      {
        eventId: 'sup_replayed_0000000000000000000000000000000000000000000000000000000000',
        workspaceId: world.workspaces.alpha.workspaceId,
        scope: 'handle' as const,
        canonicalKey: 'lost@example.test',
        canonicalizerVersion: 'handle.1',
        source: 'prospect_opt_out',
        actorUserId: null,
        commandId: null,
        supersedesEventId: null,
        supersessionReason: null,
        recordedAt: '2026-09-02T12:31:00.000Z',
      },
    ];

    const first = await replaySuppressionJournal(context, { records });
    expect(first).toMatchObject({ inserted: 1, alreadyPresent: 1 });
    const second = await replaySuppressionJournal(context, { records });
    expect(second).toMatchObject({ inserted: 0, alreadyPresent: 2 });

    // A prospect-originated opt-out reconstructed by the replay is terminal at once
    // (Appendix G 30): the finalization marker is written, not a correction window.
    const finalization = await world.session.query<{ outcome: string }>(
      'SELECT outcome FROM suppression_finalizations WHERE workspace_id = $1 AND event_id = $2',
      [world.workspaces.alpha.workspaceId, records[1]?.eventId],
    );
    expect(finalization.rows[0]?.outcome).toBe('finalized');

    // And it landed in alpha only.
    const inBeta = await world.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM suppression_events WHERE workspace_id = $1 AND event_id = $2',
      [world.workspaces.beta.workspaceId, records[1]?.eventId],
    );
    expect(inBeta.rows[0]?.count).toBe('0');
  });

  it('refuses a record that belongs to another workspace rather than moving it', async () => {
    const context = repositoryContext(
      workspaceScope(world.workspaces.beta.workspaceId, MIGRATION_SCOPE),
      world.session,
    );
    const report = await replaySuppressionJournal(context, {
      records: [
        {
          eventId: 'sup_foreign_000000000000000000000000000000000000000000000000000000000',
          workspaceId: world.workspaces.alpha.workspaceId,
          scope: 'handle',
          canonicalKey: 'foreign@example.test',
          canonicalizerVersion: 'handle.1',
          source: 'prospect_opt_out',
          actorUserId: null,
          commandId: null,
          supersedesEventId: null,
          supersessionReason: null,
          recordedAt: '2026-09-02T12:32:00.000Z',
        },
      ],
    });
    expect(report).toMatchObject({ inserted: 0, foreign: 1 });
  });
});
