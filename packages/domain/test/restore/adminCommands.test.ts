import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { enqueueJob } from '../../jobs/jobStore.ts';
import { ALL_BLOCKED_ACTION_KINDS, listHoldsByReason, openHold } from '../../policy/index.ts';
import { deterministicEventId } from '../../suppression/journal.ts';
import { parseSuppressionJournalRecord, replaySuppressionJournal } from '../../suppression/replay.ts';
import {
  advanceSystemGeneration,
  composeRestoreReport,
  countRecoveryEffects,
  countRepeatedSends,
  discardRunnableJobs,
  listOpenHolds,
  newestCrmEditAt,
  readRestoreCounts,
  readUnresolvedExceptions,
} from '../../restore/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { seedOutbound, type SeededOutbound } from '../db/support/outboundFixtures.ts';

/**
 * The Appendix E operations the `fss admin` command line wraps (lane G12g).
 *
 * `infra/scripts/rehearsal-restore-drill.sh` counts five protected kinds, replays the
 * journal, discards runnable job state, advances the generation and reports what is
 * unresolved. Every one of those was a sentence in a runbook and nothing a process
 * could run; these are the functions, and this is where their shapes are pinned —
 * the drill parses the JSON field for field.
 *
 * ## The vacuous-pass trap, named
 *
 * The drill's own trap is "a restore drill against an empty database proves nothing",
 * and the same trap sits under these functions: `readRestoreCounts` against an empty
 * database returns five zeroes and every assertion about it would hold. So the
 * fixtures seed all five kinds in **both** workspaces, and every count is asserted
 * per workspace as well as in total — a query that lost its `workspace_id` would
 * double alpha's numbers rather than merely returning something plausible.
 */

const MIGRATION_SCOPE = { kind: 'system', component: 'migration' } as const;

interface World {
  readonly database: TestDatabase;
  readonly session: SessionQueryable;
  readonly workspaces: TwoWorkspaces;
  readonly crm: SeededCrm;
  readonly mail: SeededMail;
  readonly outbound: SeededOutbound;
}

let world: World;

/** The instant every count in this file is measured at or around. */
const AS_OF = '2026-09-03T00:00:00.000Z';
/** Before anything the fixtures wrote, so "as of then, nothing had happened" is checked. */
const BEFORE_EVERYTHING = '2026-08-01T00:00:00.000Z';

async function seedRestoreActivity(session: SessionQueryable, workspaces: TwoWorkspaces, crm: SeededCrm, mail: SeededMail): Promise<void> {
  for (const [name, workspace] of [['alpha', workspaces.alpha], ['beta', workspaces.beta]] as const) {
    const firm = name === 'alpha' ? crm.alpha : crm.beta;
    const mailbox = name === 'alpha' ? mail.alpha : mail.beta;

    // A prospect-originated opt-out: terminal the instant it commits (10.2).
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

    // An ordinary CRM edit, with no protected effect.
    await session.query(
      `INSERT INTO audit_events (workspace_id, occurred_at, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
       VALUES ($1, TIMESTAMPTZ '2026-09-02T12:05:00Z', 'user', $2, 'firm.updated', 'firm', $3, '{}'::jsonb)`,
      [workspace.workspaceId, workspace.salesperson.userId, firm.firmId],
    );

    // The four effects Appendix E step 4 says must reapply, one of each. An effect
    // that says an address was suppressed names the event (0009's constraint), so the
    // opt-out's effect carries the event just written.
    for (const [kind, target] of [
      ['opportunity_manual', firm.opportunityId],
      ['handle_suppressed', `opt-out-${name}@example.test`],
      ['direct_send_manual', firm.firmId],
      ['route_invalidated', firm.firmId],
    ] as const) {
      await session.query(
        `INSERT INTO mail_message_effects
           (workspace_id, mail_message_id, effect_kind, target_key, suppression_event_id, applied_at)
         VALUES ($1, $2, $3, $4, $5, TIMESTAMPTZ '2026-09-02T12:10:00Z')`,
        [
          workspace.workspaceId,
          mailbox.messageId,
          kind,
          target,
          kind === 'handle_suppressed' ? eventId : null,
        ],
      );
    }
  }
}

beforeAll(async () => {
  const database = await createTestDatabase();
  const { session } = database;
  const workspaces = await seedTwoWorkspaces(session);
  const crm = await seedCrm(session, workspaces);
  const mail = await seedMail(session, workspaces, crm);
  const outbound = await seedOutbound(session, workspaces, crm, mail);
  await seedRestoreActivity(session, workspaces, crm, mail);
  world = { database, session, workspaces, crm, mail, outbound };
});

afterAll(async () => {
  await world.database.drop();
});

describe('fss admin counts', () => {
  it('counts all five protected kinds, so the drill has something to reconstruct', async () => {
    // As of now, because `schema_versions.applied_at` is when the migrations really
    // ran — this minute — while the business rows carry the fixture's own instants.
    // An `--as-of` in the fixture's past would count the activity and none of the
    // migrations, which is the next test rather than this one.
    const counts = await readRestoreCounts(world.session, {});
    // Appendix G 11's five kinds. Two workspaces seeded one each, so every total is two
    // — except the migrations, which are the schema's and are not per workspace.
    expect(counts.sends).toBe(2);
    expect(counts.replies).toBe(2);
    expect(counts.suppressions).toBe(2);
    expect(counts.crm_edits).toBe(2);
    expect(counts.migrations).toBeGreaterThanOrEqual(14);
  });

  it('keeps the two workspaces apart, so a lost workspace_id is visible as a doubling', async () => {
    const counts = await readRestoreCounts(world.session, {});
    expect(counts.workspaces).toHaveLength(2);
    for (const workspace of counts.workspaces) {
      expect(workspace.sends).toBe(1);
      expect(workspace.replies).toBe(1);
      expect(workspace.suppressions).toBe(1);
      expect(workspace.crm_edits).toBe(1);
    }
    const ids = counts.workspaces.map(entry => entry.workspaceId).sort();
    expect(ids).toEqual([world.workspaces.alpha.workspaceId, world.workspaces.beta.workspaceId].sort());
  });

  it('is as of an instant, not now: before the activity every business count is zero', async () => {
    const counts = await readRestoreCounts(world.session, { asOf: BEFORE_EVERYTHING });
    expect(counts.asOf).toBe(BEFORE_EVERYTHING);
    expect(counts.migrations).toBe(0);
    expect(counts.sends).toBe(0);
    expect(counts.replies).toBe(0);
    expect(counts.suppressions).toBe(0);
    expect(counts.crm_edits).toBe(0);
  });

  it('reports the newest CRM edit, which is what the accepted RPO is measured from', async () => {
    const newest = await newestCrmEditAt(world.session);
    expect(newest).not.toBeNull();
    expect(Date.parse(newest ?? '')).toBe(Date.parse('2026-09-02T12:05:00Z'));
  });
});

describe('fss admin mailbox recover', () => {
  it('counts the four effect kinds Appendix E step 4 reapplies, by the names the drill parses', async () => {
    const effects = await countRecoveryEffects(world.session, { since: '2026-09-01T00:00:00.000Z' });
    expect(effects).toMatchObject({ replies: 2, opt_outs: 2, direct_sends: 2, bounces: 2 });
  });

  it('is bounded by --since, so a window that predates nothing reports nothing', async () => {
    const effects = await countRecoveryEffects(world.session, { since: '2026-09-03T00:00:00.000Z' });
    expect(effects).toMatchObject({ replies: 0, opt_outs: 0, direct_sends: 0, bounces: 0 });
  });
});

describe('fss admin jobs discard-runnable', () => {
  it('discards runnable state and keeps the dead jobs the audit trail needs (13.2)', async () => {
    for (const workspace of [world.workspaces.alpha, world.workspaces.beta]) {
      await enqueueJob(world.session, {
        workspaceId: workspace.workspaceId,
        kind: 'canary',
        idempotencyKey: `discard-queued-${workspace.slug}`,
        payload: {},
      });
      await enqueueJob(world.session, {
        workspaceId: workspace.workspaceId,
        kind: 'today.build',
        idempotencyKey: `discard-dead-${workspace.slug}`,
        payload: {},
      });
      await world.session.query(
        `UPDATE jobs SET state = 'dead', dead_at = now(), attempt_count = max_attempts
          WHERE workspace_id = $1 AND idempotency_key = $2`,
        [workspace.workspaceId, `discard-dead-${workspace.slug}`],
      );
    }

    const report = await discardRunnableJobs(world.session);
    expect(report.discarded).toBeGreaterThanOrEqual(2);
    expect(report.dead_kept).toBe(2);

    const remaining = await world.session.query<{ state: string; count: string }>(
      'SELECT state, count(*)::text AS count FROM jobs GROUP BY state',
    );
    expect(remaining.rows).toEqual([{ state: 'dead', count: '2' }]);
  });
});

describe('fss admin holds list', () => {
  it('lists by reason across workspaces, and excludes by reason, without crossing', async () => {
    const alpha = repositoryContext(workspaceScope(world.workspaces.alpha.workspaceId, MIGRATION_SCOPE), world.session);
    const beta = repositoryContext(workspaceScope(world.workspaces.beta.workspaceId, MIGRATION_SCOPE), world.session);
    await openHold(alpha, {
      scopeKind: 'workspace',
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: 'restore.generation_mismatch',
    });
    await openHold(beta, {
      scopeKind: 'workspace',
      reasonCode: 'scoped_pause',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: 'admin.pause',
    });

    const restore = await listOpenHolds(world.session, { reason: 'restore_in_progress' });
    expect(restore).toHaveLength(1);
    expect(restore[0]?.workspaceId).toBe(world.workspaces.alpha.workspaceId);

    const others = await listOpenHolds(world.session, { excludeReason: 'restore_in_progress' });
    // The mail fixture opens a hold of its own in each workspace, so "everything else"
    // is more than the pause; what matters is that the restore hold is not in it.
    expect(others.every(hold => hold.reasonCode !== 'restore_in_progress')).toBe(true);
    expect(others.some(hold => hold.reasonCode === 'scoped_pause')).toBe(true);

    // The scoped read the release path uses answers only for its own workspace.
    expect(await listHoldsByReason(alpha, { reason: 'scoped_pause' })).toHaveLength(0);
    expect(await listHoldsByReason(beta, { reason: 'scoped_pause' })).toHaveLength(1);
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

describe('fss admin restore-report and system-generation advance', () => {
  it('reports the unresolved exceptions rather than resolving them', async () => {
    // Appendix B's state machine only allows prepared → dispatching → reconciling, so
    // the fence is walked there rather than teleported: a fixture that reached an
    // impossible state would be proving something about a row that cannot exist.
    await world.session.query(
      `UPDATE outbound_messages
          SET state = 'dispatching', attempt_token = gen_random_uuid(), dispatch_started_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [world.workspaces.alpha.workspaceId, world.outbound.alpha.preparedFenceId],
    );
    await world.session.query(
      `UPDATE outbound_messages
          SET state = 'reconciling', reconcile_started_at = now(),
              reconcile_deadline_at = now() + interval '24 hours'
        WHERE workspace_id = $1 AND id = $2`,
      [world.workspaces.alpha.workspaceId, world.outbound.alpha.preparedFenceId],
    );
    const unresolved = await readUnresolvedExceptions(world.session);
    expect(unresolved.reconciling).toHaveLength(1);
    expect(unresolved.reconciling[0]?.workspaceId).toBe(world.workspaces.alpha.workspaceId);
    expect(unresolved.unknownTerminal).toHaveLength(0);
    expect(unresolved.deadJobs).toBe(2);
  });

  it('counts a repeated send as a step execution with two accepted sends, and there is none', async () => {
    expect(await countRepeatedSends(world.session)).toBe(0);
  });

  it('composes the report the drill asserts on, and reports the RPO rather than hiding it', () => {
    const report = composeRestoreReport({
      before: { asOf: AS_OF, sends: 2, replies: 2, suppressions: 2, crm_edits: 2, migrations: 14 },
      after: { asOf: AS_OF, sends: 2, replies: 2, suppressions: 3, crm_edits: 1, migrations: 14 },
      sendsRepeated: 0,
      crmRpoSeconds: 300,
      unresolved: { reconciling: [], unknownTerminal: [], ambiguousHeld: [], deadJobs: 2 },
    });
    expect(report.suppressions_before).toBe(2);
    expect(report.suppressions_after).toBe(3);
    expect(report.sends_repeated).toBe(0);
    expect(report.crm_rpo_seconds).toBe(300);
    expect(Array.isArray(report.unresolved)).toBe(true);
  });

  it('refuses to advance the generation for a user who is not an admin', async () => {
    const outcome = await advanceSystemGeneration(world.session, {
      adminUserId: world.workspaces.alpha.salesperson.userId,
      notes: 'drill',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'not_admin' });
  });

  it('advances it for an admin and releases the restore holds only', async () => {
    const beta = repositoryContext(workspaceScope(world.workspaces.beta.workspaceId, MIGRATION_SCOPE), world.session);
    const otherHoldsBefore = (await listOpenHolds(world.session, { excludeReason: 'restore_in_progress' })).length;

    const outcome = await advanceSystemGeneration(world.session, {
      adminUserId: world.workspaces.alpha.admin.userId,
      notes: 'restore drill step 9',
    });
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.value.generation).toBe(2);
    expect(outcome.value.releasedRestoreHolds).toBe(1);

    expect(await listOpenHolds(world.session, { reason: 'restore_in_progress' })).toHaveLength(0);
    // 4.3: "Clearing one hold never clears another."
    expect(await listOpenHolds(world.session, { excludeReason: 'restore_in_progress' })).toHaveLength(
      otherHoldsBefore,
    );
    expect(await listHoldsByReason(beta, { reason: 'scoped_pause' })).toHaveLength(1);
  });
});
