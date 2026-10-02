import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepChannel } from '@fss/contracts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { authorizeDial } from '../../dial/authorize.ts';
import { CHANNEL_ACTION_KINDS, holdSource, type StepEligibilityInput } from '../../sequences/eligibility.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { recordingSuppressionJournal, type SuppressionJournalRecord } from '../../suppression/journal.ts';
import { replaySuppressionJournal } from '../../suppression/replay.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * The manual-suppression review hold follows the stop's channel (DESIGN-S3X §2.3a, RESET B).
 *
 * A `salesperson_manual` stop with firm context opens a ten-minute hold on the firm. Before
 * 0037 that hold blocked all four action kinds whatever the stop covered, which crossed
 * channels during the correction window even though the suppression reads were filtered.
 *
 *   * `email` → `email_send` only: an e-mail step is held, a call-task step and a dial are not;
 *   * `phone` → `call_task` and `dial_authorization`: e-mail is not held by it;
 *   * `all` → all four, `enrollment_advance` included.
 *
 * Two shapes of manual stop open that hold:
 *
 *   * a handle stop with firm context, on a key that belongs to nobody at the firm, so the
 *     only thing that can refuse a dial or a step is the hold. Since brief RF (X5) its journal
 *     record carries the firm and its replay reopens the same hold (`restorePath.test.ts`);
 *     one journalled before RF carries none and replays with no hold;
 *   * a firm stop, whose replay reopens the hold: replayed from the journal record the
 *     original write appended, it opens exactly the same set.
 *
 * Fails on revert: put back the constant four-kind set, or add `enrollment_advance` to the
 * `email` set, and the e-mail separation cases fail.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let policy: SeededPolicy;

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  policy = await seedPolicy(database.session, seeded, crm);
});

afterAll(async () => {
  await database.drop();
});

const salesperson = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
    database.session,
  );
const system = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

/** Inside one transaction that is always rolled back, so each case starts from the same firm. */
async function rolledBack<T>(work: () => Promise<T>): Promise<T> {
  await database.session.query('BEGIN');
  try {
    return await work();
  } finally {
    await database.session.query('ROLLBACK');
  }
}

const stepHeld = async (channel: StepChannel): Promise<boolean> => {
  const input = {
    execution: { enrollmentId: randomUUID() },
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId: crm.alpha.contactId,
    ownerUserId: seeded.alpha.salesperson.userId,
    channel,
    actionKind: CHANNEL_ACTION_KINDS[channel],
    now: policy.insideWindow,
  } as unknown as StepEligibilityInput;
  const outcome = await holdSource().evaluate(salesperson(), input);
  return !outcome.ok;
};

const dial = async () =>
  await authorizeDial(salesperson(), {
    firmId: crm.alpha.firmId,
    contactId: crm.alpha.contactId,
    routeId: policy.alpha.phoneRouteId,
    routeVersion: policy.alpha.phoneRouteVersion,
    callingIdentityId: policy.alpha.callingIdentityId,
    at: policy.insideWindow,
  });

const holdKinds = async (eventId: string): Promise<readonly string[]> => {
  const { rows } = await database.session.query<{ kinds: string[] }>(
    `SELECT blocked_action_kinds AS kinds FROM active_holds
      WHERE workspace_id = $1 AND source_event_id = $2 AND reason_code = 'manual_suppression_review' AND released_at IS NULL`,
    [seeded.alpha.workspaceId, eventId],
  );
  return rows[0]?.kinds ?? [];
};

/**
 * A manual stop with firm context: on the firm itself, or on a key that belongs to nobody at
 * the firm.
 */
async function manualStop(
  channel: 'email' | 'phone' | 'all',
  scope: 'handle' | 'firm' = 'handle',
): Promise<{ eventId: string; record: SuppressionJournalRecord }> {
  const journal = recordingSuppressionJournal();
  const recorded = await recordSuppression(salesperson(), {
    scope,
    firmId: crm.alpha.firmId,
    ...(scope === 'firm'
      ? {}
      : { value: channel === 'phone' ? '+12125550177' : `nobody.${randomUUID().slice(0, 8)}@channels.example.test` }),
    source: 'salesperson_manual',
    channel,
    commandId: `manual-${channel}-${randomUUID()}`,
    journal,
  });
  if (!recorded.ok) throw new Error(recorded.reason);
  expect(recorded.value.reviewHoldIds).toHaveLength(1);
  const record = journal.appended[0];
  if (record === undefined) throw new Error('nothing was journalled');
  return { eventId: recorded.value.eventId, record };
}

interface Seen {
  readonly kinds: readonly string[];
  readonly emailHeld: boolean;
  readonly callTaskHeld: boolean;
  readonly dial: string;
}

const observe = async (eventId: string): Promise<Seen> => {
  const decided = await dial();
  return {
    kinds: [...(await holdKinds(eventId))].sort(),
    emailHeld: await stepHeld('email'),
    callTaskHeld: await stepHeld('call_task'),
    dial: decided.allowed ? 'allowed' : decided.reason,
  };
};

/** What a handle stop's hold does as written. */
async function written(channel: 'email' | 'phone' | 'all'): Promise<Seen> {
  return await rolledBack(async () => await observe((await manualStop(channel)).eventId));
}

/** What a firm stop's hold does, as written and then as replayed from its own journal record. */
async function writtenAndReplayed(channel: 'email' | 'phone' | 'all'): Promise<{ written: Seen; replayed: Seen; replayedChannel: string }> {
  const made = await rolledBack(async () => {
    const stop = await manualStop(channel, 'firm');
    return { ...stop, written: await observe(stop.eventId) };
  });
  // The row is gone with the rollback; the journal object is not (10.2's safe direction).
  const again = await rolledBack(async () => {
    const report = await replaySuppressionJournal(system(), { records: [made.record] });
    expect(report).toMatchObject({ inserted: 1, windowsReopened: 1 });
    const { rows } = await database.session.query<{ channel: string }>(
      'SELECT channel FROM suppression_events WHERE workspace_id = $1 AND event_id = $2',
      [seeded.alpha.workspaceId, made.eventId],
    );
    return { replayed: await observe(made.eventId), replayedChannel: rows[0]?.channel ?? '' };
  });
  return { written: made.written, ...again };
}

describe('the manual-suppression review hold follows the channel (§2.3a)', () => {
  it('starts from a firm nothing holds: an e-mail step, a call-task step and a dial all pass', async () => {
    await rolledBack(async () => {
      expect(await stepHeld('email')).toBe(false);
      expect(await stepHeld('call_task')).toBe(false);
      expect(await dial()).toMatchObject({ allowed: true });
    });
  });

  it('an e-mail stop holds e-mail steps only: not a call-task step, and not a dial', async () => {
    expect(await written('email')).toEqual({ kinds: ['email_send'], emailHeld: true, callTaskHeld: false, dial: 'allowed' });
  });

  it('a phone stop holds dialling and call-task steps, and leaves e-mail to the other checks', async () => {
    expect(await written('phone')).toEqual({
      kinds: ['call_task', 'dial_authorization'],
      emailHeld: false,
      callTaskHeld: true,
      dial: 'manual_suppression_review',
    });
  });

  it('an all stop holds all four, enrollment_advance included', async () => {
    expect(await written('all')).toEqual({
      kinds: ['call_task', 'dial_authorization', 'email_send', 'enrollment_advance'],
      emailHeld: true,
      callTaskHeld: true,
      dial: 'manual_suppression_review',
    });
  });

  it('a firm e-mail stop: the same e-mail-only hold as written and as replayed; dialling is not stopped', async () => {
    const { written: first, replayed, replayedChannel } = await writtenAndReplayed('email');
    const expected: Seen = { kinds: ['email_send'], emailHeld: true, callTaskHeld: false, dial: 'allowed' };
    expect(first).toEqual(expected);
    expect(replayed).toEqual(expected);
    expect(replayedChannel).toBe('email');
  });

  it('a firm phone stop: the same calls hold as written and as replayed (the dial is refused by the stop itself first)', async () => {
    const { written: first, replayed, replayedChannel } = await writtenAndReplayed('phone');
    const expected: Seen = { kinds: ['call_task', 'dial_authorization'], emailHeld: false, callTaskHeld: true, dial: 'firm_suppressed' };
    expect(first).toEqual(expected);
    expect(replayed).toEqual(expected);
    expect(replayedChannel).toBe('phone');
  });

  it('a firm all stop: all four as written and as replayed', async () => {
    const { written: first, replayed, replayedChannel } = await writtenAndReplayed('all');
    const expected: Seen = {
      kinds: ['call_task', 'dial_authorization', 'email_send', 'enrollment_advance'],
      emailHeld: true,
      callTaskHeld: true,
      dial: 'firm_suppressed',
    };
    expect(first).toEqual(expected);
    expect(replayed).toEqual(expected);
    expect(replayedChannel).toBe('all');
  });

  it('replays a record that parsed as all (every pre-0037 object) with the broad hold', async () => {
    const { record } = await rolledBack(async () => await manualStop('phone', 'firm'));
    // The id is the record's own; only the channel the parser would have given an old body changes.
    await rolledBack(async () => {
      await replaySuppressionJournal(system(), { records: [{ ...record, channel: 'all' }] });
      expect([...(await holdKinds(record.eventId))].sort()).toEqual(['call_task', 'dial_authorization', 'email_send', 'enrollment_advance']);
    });
  });
});

describe('recordSuppression refuses a channel its key cannot carry, before anything is journalled (P1-6)', () => {
  it('refuses email on a number and phone on an address; accepts any channel on a firm', async () => {
    await rolledBack(async () => {
      for (const [value, channel] of [
        ['+12125550166', 'email'],
        ['someone@channels.example.test', 'phone'],
      ] as const) {
        const journal = recordingSuppressionJournal();
        const refused = await recordSuppression(salesperson(), {
          scope: 'handle',
          value,
          source: 'prospect_opt_out',
          channel,
          journal,
        });
        expect(refused).toEqual({ ok: false, reason: 'invalid_input' });
        expect(journal.appended).toEqual([]);
      }
      for (const channel of ['phone', 'email', 'all'] as const) {
        const recorded = await recordSuppression(salesperson(), {
          scope: 'firm',
          firmId: crm.alpha.firmId,
          source: 'prospect_do_not_call',
          channel,
          commandId: `firm-${channel}`,
          journal: recordingSuppressionJournal(),
        });
        expect(recorded.ok, channel).toBe(true);
      }
    });
  });

  it('refuses a supersession that names a different channel (suppression_events_supersession_same_key)', async () => {
    await rolledBack(async () => {
      await database.session.query(
        `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, channel)
         VALUES ($1, 'channel-original', 'firm', $2, 'e164-lower.1', 'prospect_do_not_call', 'phone')`,
        [seeded.alpha.workspaceId, crm.alpha.firmId],
      );
      await expect(
        database.session.query(
          `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
                                           supersedes_event_id, supersession_reason, channel)
           VALUES ($1, 'channel-lift', 'firm', $2, 'e164-lower.1', 'admin_supersession', 'channel-original', 'correction', 'all')`,
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        ),
      ).rejects.toMatchObject({ constraint: 'suppression_events_supersession_same_key' });
    });
  });
});
