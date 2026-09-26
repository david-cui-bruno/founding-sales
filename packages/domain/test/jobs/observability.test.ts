import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  METRIC_OWNERS,
  MetricError,
  acknowledgeCriticalAlert,
  canaryCompletionAgeSeconds,
  claimJobs,
  collectJobMetrics,
  completeCanaryRun,
  completeJob,
  createMetricSink,
  enqueueJob,
  failJob,
  incrementDailyCounter,
  insertCanaryRun,
  listOpenAlerts,
  quarterHourOf,
  raiseCriticalAlert,
  readDailyCounter,
  readHeartbeats,
  recordHeartbeat,
  recordingMetricSink,
  resolveCriticalAlert,
  unacknowledgedCriticalAlertAgeSeconds,
  type MetricDatum,
} from '../../jobs/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Counters, heartbeats, the canary, the alert acknowledgement and the metric adapter.
 *
 * The last test in this file is the one that keeps the rest honest: it reads the two
 * Terraform files that name the metrics the alarms watch and fails when a name there
 * has no owner here, or an owner here names a metric no alarm reads. An alarm over a
 * metric nobody emits never fires, and that is worse than no alarm at all.
 */

const ALERTS_TF = fileURLToPath(new URL('../../../../infra/modules/alerts/main.tf', import.meta.url));
const OBSERVABILITY_TF = fileURLToPath(new URL('../../../../infra/modules/observability/main.tf', import.meta.url));

function metricNamesIn(file: string): Set<string> {
  const text = readFileSync(file, 'utf8');
  const names = new Set<string>();
  for (const match of text.matchAll(/metric_name\s*=\s*"([A-Za-z0-9]+)"/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

describe('counters, heartbeats, the canary and alerts', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let alpha: RepositoryContext;
  let beta: RepositoryContext;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    alpha = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    beta = repositoryContext(
      workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.admin.userId, role: 'admin' }),
      database.session,
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  // ------------------------------------------------------------------ counters
  it('increments a daily counter atomically and refuses at the ceiling', async () => {
    const key = {
      subjectKind: 'mailbox' as const,
      subjectKey: 'david@example.test',
      counterKind: 'automated_sends',
      businessTimeZone: 'America/New_York',
      at: '2026-09-21T14:00:00.000Z',
    };
    expect(await incrementDailyCounter(alpha, key, 3)).toEqual({ allowed: true, count: 1, businessDate: '2026-09-21' });
    expect(await incrementDailyCounter(alpha, key, 3)).toEqual({ allowed: true, count: 2, businessDate: '2026-09-21' });
    expect(await incrementDailyCounter(alpha, key, 3)).toEqual({ allowed: true, count: 3, businessDate: '2026-09-21' });
    expect(await incrementDailyCounter(alpha, key, 3)).toEqual({
      allowed: false,
      count: 3,
      businessDate: '2026-09-21',
      reason: 'ceiling_reached',
    });
    // A ceiling of zero refuses the very first increment too, and writes no row.
    const fresh = { ...key, counterKind: 'blocked_sends' };
    expect(await incrementDailyCounter(alpha, fresh, 0)).toMatchObject({ allowed: false, count: 0 });
    expect(await readDailyCounter(alpha, fresh)).toBe(0);

    // The other workspace's mailbox of the same name has its own count.
    expect(await readDailyCounter(beta, key)).toBe(0);
    expect(await incrementDailyCounter(beta, key, 3)).toMatchObject({ allowed: true, count: 1 });
    expect(await readDailyCounter(alpha, key)).toBe(3);
  });

  it('dates the counter in the workspace business zone, not UTC', async () => {
    // 01:30 UTC on the 22nd is still the 21st in New York, and the cap counts there.
    const key = {
      subjectKind: 'owner' as const,
      subjectKey: seeded.alpha.salesperson.userId,
      counterKind: 'automated_sends',
      businessTimeZone: 'America/New_York',
      at: '2026-09-22T01:30:00.000Z',
    };
    const outcome = await incrementDailyCounter(alpha, key, 10);
    expect(outcome.businessDate).toBe('2026-09-21');

    const { rows } = await database.session.query<{ business_time_zone: string }>(
      `SELECT business_time_zone FROM daily_counters
        WHERE workspace_id = $1 AND subject_kind = 'owner' AND counter_kind = 'automated_sends'`,
      [seeded.alpha.workspaceId],
    );
    expect(rows[0]?.business_time_zone).toBe('America/New_York');
  });

  // ---------------------------------------------------------------- heartbeats
  it('upserts a heartbeat per component and knows a stale one from a fresh one', async () => {
    await recordHeartbeat(database.session, { component: 'api', instanceKey: 'api-1' });
    await recordHeartbeat(database.session, { component: 'scheduler', instanceKey: 'scheduler-1' });
    await recordHeartbeat(database.session, { component: 'worker', instanceKey: 'worker-1' });
    await recordHeartbeat(database.session, {
      component: 'mailbox',
      workspaceId: seeded.alpha.workspaceId,
      instanceKey: 'david@example.test',
      expectedIntervalSeconds: 120,
    });
    // A second beat updates rather than appends.
    await recordHeartbeat(database.session, { component: 'api', instanceKey: 'api-1', detail: { passes: 2 } });

    const beats = await readHeartbeats(database.session);
    expect(beats.map(beat => beat.component)).toEqual(['api', 'mailbox', 'scheduler', 'worker']);
    expect(beats.every(beat => beat.fresh)).toBe(true);
    expect(beats.find(beat => beat.component === 'mailbox')?.workspaceId).toBe(seeded.alpha.workspaceId);
    expect(beats.find(beat => beat.component === 'mailbox')?.expectedIntervalSeconds).toBe(120);

    await database.session.query(
      "UPDATE heartbeats SET observed_at = now() - INTERVAL '5 minutes' WHERE component = 'scheduler'",
    );
    const stale = (await readHeartbeats(database.session)).find(beat => beat.component === 'scheduler');
    expect(stale?.fresh).toBe(false);
    expect(stale?.ageSeconds).toBeGreaterThan(60);
  });

  // -------------------------------------------------------------------- canary
  it('inserts one canary row per quarter hour and completes it once', async () => {
    const at = '2026-09-21T14:07:33.000Z';
    const quarterHour = quarterHourOf(at);
    expect(quarterHour).toBe('2026-09-21T14:00:00.000Z');

    const first = await insertCanaryRun(database.session, seeded.alpha.workspaceId, at);
    const again = await insertCanaryRun(database.session, seeded.alpha.workspaceId, '2026-09-21T14:14:59.000Z');
    expect(first.inserted).toBe(true);
    expect(again.inserted).toBe(false);
    expect(again.quarterHour).toBe(quarterHour);

    // The run exists and nobody has completed it, so the metric is already the gap
    // between the insert and now rather than null (g41): that gap is the thing that
    // grows past the threshold when the worker is dead.
    const uncompleted = await canaryCompletionAgeSeconds(database.session);
    expect(uncompleted).not.toBeNull();
    expect(uncompleted ?? -1).toBeGreaterThanOrEqual(0);
    expect(uncompleted ?? -1).toBeLessThan(60);

    expect(await completeCanaryRun(database.session, seeded.alpha.workspaceId, quarterHour, 'worker-1')).toBe(true);
    // Written once: a replayed handler does not move the timestamp the alarm reads.
    expect(await completeCanaryRun(database.session, seeded.alpha.workspaceId, quarterHour, 'worker-2')).toBe(false);

    const age = await canaryCompletionAgeSeconds(database.session);
    expect(age).not.toBeNull();
    expect(age ?? -1).toBeLessThan(60);

    const { rows } = await database.session.query<{ completed_by: string }>(
      'SELECT completed_by FROM canary_runs WHERE workspace_id = $1 AND quarter_hour = $2::timestamptz',
      [seeded.alpha.workspaceId, quarterHour],
    );
    expect(rows[0]?.completed_by).toBe('worker-1');
  });

  it('refuses a canary row that is not on a quarter-hour boundary', async () => {
    await expect(
      database.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:07:00+00')",
        [seeded.alpha.workspaceId],
      ),
    ).rejects.toMatchObject({ constraint: 'canary_runs_quarter_hour_aligned' });
  });

  /**
   * The metric is a **latency**, not a time since the last completion (g41).
   *
   * The first production smoke read `age=359.441672s` off a healthy system and failed,
   * because the canary is inserted once per quarter hour and "seconds since the newest
   * completion" sawtooths to 900 between them. These four cases are the distinction:
   * the first is the one the old query could not pass, the second is the failure the
   * alarm exists for, the third is the one a single newest row would hide, and the
   * fourth is the absence the alarm's breaching treatment of missing data reads.
   *
   * ## The vacuous-pass trap, named
   *
   * A case that completed a run and asserted "small" would pass under either meaning,
   * because a run completed a moment ago is both a short latency and a short time since
   * completion. Closed by completing a run **twenty minutes ago** with a three-second
   * latency: the two readings are 3 and 1200, and only one of them is under the
   * five-minute threshold the alarm and the smoke compare against.
   */
  const insertCanaryRow = async (
    workspaceId: string,
    quarterHour: string,
    insertedAgo: string,
    latency: string | null,
  ): Promise<void> => {
    // `now()` is evaluated once per statement, so the two timestamps are exactly
    // `latency` apart however long the test takes.
    await database.session.query(
      latency === null
        ? `INSERT INTO canary_runs (workspace_id, quarter_hour, inserted_at)
           VALUES ($1, $2::timestamptz, now() - $3::interval)`
        : `INSERT INTO canary_runs (workspace_id, quarter_hour, inserted_at, completed_at, completed_by)
           VALUES ($1, $2::timestamptz, now() - $3::interval, now() - $3::interval + $4::interval, 'worker-1')`,
      latency === null ? [workspaceId, quarterHour, insertedAgo] : [workspaceId, quarterHour, insertedAgo, latency],
    );
  };

  it('is null when no canary run exists at all', async () => {
    await database.session.query('DELETE FROM canary_runs');
    expect(await canaryCompletionAgeSeconds(database.session)).toBeNull();
  });

  it('reads the newest run’s completion latency, not how long ago it completed', async () => {
    await database.session.query('DELETE FROM canary_runs');
    // Completed twenty minutes ago, three seconds after it was inserted. The old query
    // read 1200 here and failed the 300-second check; the latency is 3.
    await insertCanaryRow(seeded.alpha.workspaceId, '2026-09-21T15:00:00.000Z', '20 minutes', '3 seconds');
    expect(await canaryCompletionAgeSeconds(database.session)).toBe(3);
  });

  it('grows with now while the newest run has not been completed', async () => {
    await database.session.query('DELETE FROM canary_runs');
    await insertCanaryRow(seeded.alpha.workspaceId, '2026-09-21T15:15:00.000Z', '400 seconds', null);
    const age = await canaryCompletionAgeSeconds(database.session);
    // Past 300 within five minutes of the worker stopping, which is the alarm and the
    // smoke check. A worker that dies now is over the threshold in five minutes.
    expect(age ?? -1).toBeGreaterThanOrEqual(400);
    expect(age ?? -1).toBeLessThan(460);
  });

  it('takes the worst of the workspaces, so a healthy one cannot hide a dead one', async () => {
    await database.session.query('DELETE FROM canary_runs');
    // Beta's uncompleted run is the *older* of the two, so a single
    // `ORDER BY inserted_at DESC LIMIT 1` would read alpha's two seconds and report a
    // healthy system while beta's worker had not completed anything for ten minutes.
    await insertCanaryRow(seeded.beta.workspaceId, '2026-09-21T15:30:00.000Z', '600 seconds', null);
    await insertCanaryRow(seeded.alpha.workspaceId, '2026-09-21T15:45:00.000Z', '60 seconds', '2 seconds');
    const age = await canaryCompletionAgeSeconds(database.session);
    expect(age ?? -1).toBeGreaterThanOrEqual(600);
    expect(age ?? -1).toBeLessThan(660);
  });

  // -------------------------------------------------------------------- alerts
  it('keeps one open alert per key and publishes the age of the condition', async () => {
    const first = await raiseCriticalAlert(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      alertKey: 'dead_job_unresolved',
      detail: { kind: 'retention.batch' },
    });
    expect(first.raised).toBe(true);

    await database.session.query(
      "UPDATE critical_alerts SET raised_at = now() - INTERVAL '2 hours' WHERE workspace_id = $1",
      [seeded.alpha.workspaceId],
    );
    // The condition recurring does not restart the clock the alarm reads.
    const second = await raiseCriticalAlert(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      alertKey: 'dead_job_unresolved',
      detail: { kind: 'retention.batch', seen: 2 },
    });
    expect(second.raised).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await unacknowledgedCriticalAlertAgeSeconds(database.session)).toBeGreaterThan(7000);

    expect(await listOpenAlerts(alpha)).toHaveLength(1);
    // Nothing crosses: beta's workspace has no open alert.
    expect(await listOpenAlerts(beta)).toEqual([]);
  });

  it('acknowledges only for an admin, audits it, and silences the metric', async () => {
    const open = await listOpenAlerts(alpha);
    const alert = open[0];
    expect(alert).toBeDefined();
    if (alert === undefined) return;

    const salesperson = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );
    expect(await acknowledgeCriticalAlert(salesperson, { alertId: alert.id })).toEqual({
      acknowledged: false,
      reason: 'not_admin',
    });
    // Another workspace's admin cannot see it, let alone silence it.
    expect(await acknowledgeCriticalAlert(beta, { alertId: alert.id })).toEqual({
      acknowledged: false,
      reason: 'not_open',
    });

    expect(await acknowledgeCriticalAlert(alpha, { alertId: alert.id, note: 'requeued it' })).toEqual({
      acknowledged: true,
      alertKey: 'dead_job_unresolved',
    });
    expect(await acknowledgeCriticalAlert(alpha, { alertId: alert.id })).toEqual({
      acknowledged: false,
      reason: 'already_acknowledged',
    });

    // No unacknowledged critical alert means no datapoint at all, which is how the
    // alarm's notBreaching handling of missing data says "nothing is wrong".
    expect(await unacknowledgedCriticalAlertAgeSeconds(database.session)).toBeNull();

    const audit = await database.session.query<{ detail: { alertKey?: string; note?: string } }>(
      "SELECT detail FROM audit_events WHERE workspace_id = $1 AND action = 'alert.acknowledge'",
      [seeded.alpha.workspaceId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.detail.alertKey).toBe('dead_job_unresolved');
    expect(audit.rows[0]?.detail.note).toBe('requeued it');

    expect(await resolveCriticalAlert(database.session, seeded.alpha.workspaceId, 'dead_job_unresolved')).toBe(true);
    expect(await listOpenAlerts(alpha)).toEqual([]);
    // Resolved frees the key, so the same condition may be raised again later.
    expect(
      (await raiseCriticalAlert(database.session, { workspaceId: seeded.alpha.workspaceId, alertKey: 'dead_job_unresolved' }))
        .raised,
    ).toBe(true);
    await resolveCriticalAlert(database.session, seeded.alpha.workspaceId, 'dead_job_unresolved');
  });

  // ------------------------------------------------------------------- metrics
  it('collects the gauges the alarms read, and says nothing when there is nothing to say', async () => {
    const quiet = await collectJobMetrics(database.session);
    // No runnable job and no dead job: those two names are simply absent.
    expect(quiet.map(datum => datum.name)).not.toContain('OldestRunnableJobAgeSeconds');
    expect(quiet.map(datum => datum.name)).not.toContain('DeadJobOldestAgeSeconds');
    expect(quiet.map(datum => datum.name)).toContain('CanaryCompletionAgeSeconds');
    // The scheduler heartbeat was aged out above, so it is published as zero rather
    // than omitted: its alarm treats missing data as breaching either way, and zero
    // distinguishes "we looked and it was dead" from "we could not look".
    expect(quiet.find(datum => datum.name === 'SchedulerHeartbeat')?.value).toBe(0);
    expect(quiet.find(datum => datum.name === 'ApiHeartbeat')?.value).toBe(1);

    await enqueueJob(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      kind: 'mail.reconcile',
      idempotencyKey: 'mail-reconcile:mailbox-1:2026-09-21T14:00',
      payload: {},
      maxAttempts: 1,
    });
    await database.session.query(
      "UPDATE jobs SET run_at = now() - INTERVAL '11 minutes', not_before = now() - INTERVAL '11 minutes' WHERE kind = 'mail.reconcile'",
    );
    const [claim] = await claimJobs(database.session, {
      owner: 'worker-1',
      kinds: ['mail.reconcile'],
      limit: 1,
      leaseSeconds: 30,
    });
    if (claim !== undefined) expect(await failJob(database.session, claim, { code: 'reconcile_failed' })).toBe('dead');

    await enqueueJob(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      kind: 'mail.sync',
      idempotencyKey: 'mail-sync:mailbox-2',
      payload: {},
      maxAttempts: 4,
    });
    await database.session.query(
      "UPDATE jobs SET run_at = now() - INTERVAL '6 minutes', not_before = now() - INTERVAL '6 minutes' WHERE kind = 'mail.sync'",
    );

    const loud = await collectJobMetrics(database.session);
    const byName = new Map(loud.map(datum => [datum.name, datum]));
    expect(byName.get('OldestRunnableJobAgeSeconds')?.value ?? 0).toBeGreaterThan(300);
    expect(byName.get('OldestRunnableJobAgeSeconds')?.unit).toBe('Seconds');
    expect(byName.get('DeadJobOldestAgeSeconds')?.value ?? -1).toBeGreaterThanOrEqual(0);

    // Tidy up so the next test's collection is not affected.
    const [remaining] = await claimJobs(database.session, {
      owner: 'worker-1',
      kinds: ['mail.sync'],
      limit: 1,
      leaseSeconds: 30,
    });
    if (remaining !== undefined) await completeJob(database.session, remaining);
  });

  it('is a validating no-op without a publisher, and refuses a metric no alarm reads', async () => {
    const noop = createMetricSink({ namespace: 'FSS/Test' });
    await expect(noop.publish([{ name: 'CanaryCompletionAgeSeconds', value: 12, unit: 'Seconds' }])).resolves.toBeUndefined();
    await expect(noop.publish([{ name: 'InventedByHand', value: 1, unit: 'Count' }])).rejects.toBeInstanceOf(MetricError);
    await expect(noop.publish([{ name: 'CanaryCompletionAgeSeconds', value: Number.NaN, unit: 'Seconds' }])).rejects.toBeInstanceOf(
      MetricError,
    );

    const sent: MetricDatum[][] = [];
    const publishing = createMetricSink({
      namespace: 'FSS/Test',
      putMetricData: async (_namespace, data) => {
        sent.push([...data]);
        await Promise.resolve();
      },
    });
    await publishing.publish(await collectJobMetrics(database.session));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.length ?? 0).toBeGreaterThan(0);

    const recorder = recordingMetricSink();
    await recorder.publish([{ name: 'WorkerHeartbeat', value: 1, unit: 'Count' }]);
    expect(recorder.published.map(datum => datum.name)).toEqual(['WorkerHeartbeat']);
  });

  it('claims an owner for every metric the infrastructure alarms on, and invents none', () => {
    const declared = new Set(Object.keys(METRIC_OWNERS));
    const infrastructure = new Set([...metricNamesIn(ALERTS_TF), ...metricNamesIn(OBSERVABILITY_TF)]);
    expect(infrastructure.size).toBeGreaterThan(15);

    const unowned = [...infrastructure].filter(name => !declared.has(name)).sort();
    expect(unowned, 'an alarm watches a metric nothing claims to emit').toEqual([]);

    const invented = [...declared].filter(name => !infrastructure.has(name)).sort();
    expect(invented, 'a metric is claimed here that no alarm or metric filter reads').toEqual([]);

    // The three the specification calls immediately critical are log-derived, so a
    // task that cannot reach the metrics API still raises them.
    expect(METRIC_OWNERS['SuppressionJournalWriteFailures']).toBe('log_derived');
    expect(METRIC_OWNERS['RestoreGenerationMismatches']).toBe('log_derived');
    expect(METRIC_OWNERS['OutboundSafetyInvariantFailures']).toBe('log_derived');
    // And the one G1 asked this lane for.
    expect(METRIC_OWNERS['UnacknowledgedCriticalAlertAgeSeconds']).toBe('jobs');
    // Published by the Today collector since g67, so no longer owed by a later lane.
    expect(METRIC_OWNERS['TodaySnapshotMissing']).toBe('today');
    // g72: the two stale labels made true, and the enrollment gauges given a publisher.
    // Nothing is owed by a later lane any more; `later_lane` is not a MetricOwner.
    expect(METRIC_OWNERS['GmailWatchHoursToExpiry']).toBe('mail');
    expect(METRIC_OWNERS['MailboxDisconnectedHours']).toBe('outbound');
    expect(METRIC_OWNERS['ActiveEnrollments']).toBe('sequences');
    expect(METRIC_OWNERS['HeldEnrollments']).toBe('sequences');
    expect(Object.values(METRIC_OWNERS)).not.toContain('later_lane');
  });
});
