import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import {
  HEARTBEAT_GRACE_SECONDS,
  collectJobMetrics,
  heartbeatIsFresh,
  readHeartbeats,
  recordHeartbeat,
  type MetricDatum,
} from '../../jobs/index.ts';
import { MAILBOX_CHECK_INTERVAL_SECONDS, recordMailboxHeartbeat } from '../../mail/index.ts';
import { seedTwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * What "fresh" means for each heartbeat, and what the metric the alarms read makes of
 * it (13.3, lane g58).
 *
 * The api, scheduler and worker beat on their own loops and keep the plain rule, age
 * within the promised interval. The mailbox check is asked for by the scheduler pass
 * and performed by a runner slot, so a healthy check lands 60 s plus a claim after the
 * previous one; it is allowed half an interval past its promise, and no more.
 *
 * The vacuous-pass trap is a test that only ever looks at a beat written a moment
 * ago, which is fresh under any rule at all. Every case below is a beat *backdated* to
 * an age on one side of a boundary: 75 s is the mailbox check that is late but not
 * missed, and a missed scheduler pass; 95 s is a missed mailbox check.
 */

const valueOf = (data: readonly MetricDatum[], name: string): number | undefined =>
  data.find(datum => datum.name === name)?.value;

describe('heartbeat freshness (13.3)', () => {
  let database: TestDatabase;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    workspaceId = (await seedTwoWorkspaces(database.session)).alpha.workspaceId;
  });

  afterAll(async () => {
    await database.drop();
  });

  const backdate = async (component: string, seconds: number): Promise<void> => {
    await database.session.query(
      'UPDATE heartbeats SET observed_at = now() - make_interval(secs => $2::double precision) WHERE component = $1',
      [component, seconds],
    );
  };

  it('keeps the api, scheduler and worker at exactly their promise', () => {
    for (const component of ['api', 'scheduler', 'worker'] as const) {
      expect(HEARTBEAT_GRACE_SECONDS[component], component).toBe(0);
      expect(heartbeatIsFresh({ component, ageSeconds: 60, expectedIntervalSeconds: 60 }), component).toBe(true);
      expect(heartbeatIsFresh({ component, ageSeconds: 60.5, expectedIntervalSeconds: 60 }), component).toBe(false);
    }
  });

  it('allows the mailbox check half an interval past its promise, and no more', () => {
    const check = (ageSeconds: number): boolean =>
      heartbeatIsFresh({ component: 'mailbox', ageSeconds, expectedIntervalSeconds: MAILBOX_CHECK_INTERVAL_SECONDS });
    // A pass 60.05 s after the last and a claim up to a second behind it: not a miss.
    expect(check(61.5)).toBe(true);
    expect(check(90)).toBe(true);
    // The check due at 60 s has not come by 90 s: that minute is a missed check.
    expect(check(90.5)).toBe(false);
    expect(check(180)).toBe(false);
  });

  it('writes the mailbox heartbeat with the sixty-second promise the alarm period is built on', async () => {
    const mailboxId = randomUUID();
    await recordMailboxHeartbeat(database.session, { workspaceId, mailboxId, detail: { outcome: 'synced' } });
    const { rows } = await database.session.query<{ expected_interval_seconds: number; workspace_id: string }>(
      "SELECT expected_interval_seconds, workspace_id FROM heartbeats WHERE component = 'mailbox' AND instance_key = $1",
      [mailboxId],
    );
    expect(rows).toEqual([{ expected_interval_seconds: 60, workspace_id: workspaceId }]);
    expect(MAILBOX_CHECK_INTERVAL_SECONDS).toBe(60);
  });

  it('publishes a late-but-healthy mailbox check as 1 and a missed one as 0', async () => {
    await recordMailboxHeartbeat(database.session, { workspaceId, mailboxId: randomUUID() });

    await backdate('mailbox', 75);
    const late = (await readHeartbeats(database.session)).filter(beat => beat.component === 'mailbox');
    expect(late.every(beat => beat.fresh && beat.ageSeconds >= 75)).toBe(true);
    expect(valueOf(await collectJobMetrics(database.session), 'MailboxCheckHeartbeat')).toBe(1);

    await backdate('mailbox', 95);
    const missed = (await readHeartbeats(database.session)).filter(beat => beat.component === 'mailbox');
    expect(missed.some(beat => beat.fresh)).toBe(false);
    expect(valueOf(await collectJobMetrics(database.session), 'MailboxCheckHeartbeat')).toBe(0);
  });

  it('still publishes a scheduler beat 75 seconds old as a missed pass', async () => {
    await recordHeartbeat(database.session, { component: 'scheduler', instanceKey: 'scheduler-freshness' });
    expect(valueOf(await collectJobMetrics(database.session), 'SchedulerHeartbeat')).toBe(1);

    await backdate('scheduler', 75);
    const stale = (await readHeartbeats(database.session)).find(beat => beat.component === 'scheduler');
    expect(stale?.fresh).toBe(false);
    expect(valueOf(await collectJobMetrics(database.session), 'SchedulerHeartbeat')).toBe(0);
  });
});
