import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { jobIdempotencyKey } from '../../jobs/jobKinds.ts';
import { claimJobs, completeJob, enqueueJob, failJob, type ClaimedJob } from '../../jobs/jobStore.ts';
import { recordingMetricSink } from '../../jobs/metrics.ts';
import {
  TODAY_SNAPSHOT_DEADLINE_LOCAL_MINUTE,
  collectTodayMetrics,
  readTodaySnapshotStatus,
} from '../../today/metrics.ts';
import { TODAY_ALGORITHM_VERSION } from '../../today/types.ts';

/**
 * `TodaySnapshotMissing` against a real PostgreSQL (specification 8.2, 13.3; lane g67).
 *
 * 13.3 alarms on "Today snapshot absent at 05:10 workspace time", and the gauge
 * answers it from the `today.build` job rather than from `today_snapshots`, because a
 * workspace with no firms is built and still has no rows. So every case below is a
 * job in some state, at some instant, in some zone:
 *
 * * before 05:10 local nothing is owed, built or not;
 * * from 05:10 local the day's job must be `done` — queued, running and dead are all
 *   missing, and so is a job for yesterday's date or another algorithm version;
 * * the zone is the workspace's own, so one instant can be before the deadline in New
 *   York, after it in Tokyo, and on a different business date there.
 *
 * Every instant is fixed and handed in as `now`; PostgreSQL turns a local time into
 * one, so no offset is written down by hand. The two workspaces are fictional and
 * nothing here names a person, an address or a number.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('with no workspace at all', () => {
  it('still publishes one datum, zero, with no dimension', async () => {
    expect(await readTodaySnapshotStatus(database.session, '2026-09-21T12:00:00.000Z')).toEqual([]);
    const data = await collectTodayMetrics(database.session, { now: '2026-09-21T12:00:00.000Z' });
    expect(data).toEqual([{ name: 'TodaySnapshotMissing', value: 0, unit: 'Count' }]);
  });
});

describe('TodaySnapshotMissing, from the today.build job', () => {
  const NEW_YORK = 'America/New_York';
  const TOKYO = 'Asia/Tokyo';
  let alpha = '';
  let beta = '';

  /** `HH:MM:SS` on `date` in `zone`, as a UTC instant, computed by PostgreSQL. */
  const localInstant = async (zone: string, date: string, time: string): Promise<string> => {
    const { rows } = await database.session.query<{ at: Date }>(
      'SELECT (($1::date + $2::time) AT TIME ZONE $3) AS at',
      [date, time, zone],
    );
    const at = rows[0]?.at;
    if (at === undefined) throw new Error('no instant');
    return at.toISOString();
  };

  const keyFor = (slug: string, businessDate: string, algorithm = TODAY_ALGORITHM_VERSION): string =>
    jobIdempotencyKey.todayList(slug, businessDate, algorithm);

  /** Materialize the day's job the way the scheduler does; it stays `queued`. */
  const materialize = async (workspaceId: string, idempotencyKey: string): Promise<string> => {
    const outcome = await enqueueJob(database.session, {
      workspaceId,
      kind: 'today.build',
      idempotencyKey,
      payload: { businessDate: idempotencyKey.split(':')[2] ?? '', algorithmVersion: TODAY_ALGORITHM_VERSION },
      maxAttempts: 1,
    });
    return outcome.jobId;
  };

  /** Claim the one runnable today.build job, which the caller has just materialized. */
  const claim = async (jobId: string): Promise<ClaimedJob> => {
    const [claimed] = await claimJobs(database.session, {
      owner: 'worker-test',
      kinds: ['today.build'],
      limit: 1,
      leaseSeconds: 60,
    });
    expect(claimed?.id).toBe(jobId);
    if (claimed === undefined) throw new Error('nothing was claimed');
    return claimed;
  };

  const build = async (workspaceId: string, idempotencyKey: string): Promise<void> => {
    const claimed = await claim(await materialize(workspaceId, idempotencyKey));
    expect(await completeJob(database.session, claimed)).toBe('completed');
  };

  const gauge = async (now: string): Promise<number | undefined> =>
    (await collectTodayMetrics(database.session, { now })).find(datum => datum.name === 'TodaySnapshotMissing')?.value;

  const readingOf = async (workspaceId: string, now: string) =>
    (await readTodaySnapshotStatus(database.session, now)).find(reading => reading.workspaceId === workspaceId);

  beforeAll(async () => {
    const { rows } = await database.session.query<{ id: string; slug: string }>(
      `INSERT INTO workspaces (slug, display_name, business_time_zone)
       VALUES ('alpha', 'Alpha Test', $1), ('beta', 'Beta Test', $2)
       RETURNING id, slug`,
      [NEW_YORK, TOKYO],
    );
    alpha = rows.find(row => row.slug === 'alpha')?.id ?? '';
    beta = rows.find(row => row.slug === 'beta')?.id ?? '';
    // Tokyo's build is done for every date these cases use, unless a case says
    // otherwise, so the gauge's maximum is New York's answer.
    for (const date of ['2026-09-20', '2026-09-21', '2026-09-22']) await build(beta, keyFor('beta', date));
  });

  beforeEach(async () => {
    await database.session.query("DELETE FROM jobs WHERE kind = 'today.build' AND workspace_id = $1", [alpha]);
  });

  it('holds the deadline at 05:10, ten minutes after the 05:00 build', () => {
    expect(TODAY_SNAPSHOT_DEADLINE_LOCAL_MINUTE).toBe(310);
  });

  it('reads 0 before 05:10 local, with nothing built', async () => {
    const now = await localInstant(NEW_YORK, '2026-09-21', '05:09:59');
    expect(now).toBe('2026-09-21T09:09:59.000Z');
    expect(await readingOf(alpha, now)).toEqual({
      workspaceId: alpha,
      businessDate: '2026-09-21',
      due: false,
      built: false,
      missing: false,
    });
    expect(await gauge(now)).toBe(0);
  });

  it('reads 1 from 05:10 local when no job exists for the day', async () => {
    const now = await localInstant(NEW_YORK, '2026-09-21', '05:10:00');
    expect(await readingOf(alpha, now)).toMatchObject({ businessDate: '2026-09-21', due: true, built: false, missing: true });
    expect(await gauge(now)).toBe(1);
  });

  it('reads 1 while the job is materialized but not completed: queued, running, then dead', async () => {
    const now = await localInstant(NEW_YORK, '2026-09-21', '05:30:00');
    const jobId = await materialize(alpha, keyFor('alpha', '2026-09-21'));
    expect(await gauge(now)).toBe(1);

    const claimed = await claim(jobId);
    expect(await gauge(now)).toBe(1);

    expect(await failJob(database.session, claimed, { code: 'build_failed' })).toBe('dead');
    expect(await gauge(now)).toBe(1);
  });

  it('reads 0 once the day’s job is done, and asks nothing of today_snapshots', async () => {
    const now = await localInstant(NEW_YORK, '2026-09-21', '05:30:00');
    await build(alpha, keyFor('alpha', '2026-09-21'));
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM today_snapshots WHERE workspace_id = $1',
      [alpha],
    );
    expect(rows[0]?.count).toBe('0');
    expect(await readingOf(alpha, now)).toMatchObject({ due: true, built: true, missing: false });
    expect(await gauge(now)).toBe(0);
    // And it stays 0 for the rest of the business day.
    expect(await gauge(await localInstant(NEW_YORK, '2026-09-21', '23:59:00'))).toBe(0);
  });

  it('does not count yesterday’s completed job for today', async () => {
    await build(alpha, keyFor('alpha', '2026-09-20'));
    // 23:59 on the 20th is still covered by the 20th's build.
    expect(await gauge(await localInstant(NEW_YORK, '2026-09-20', '23:59:00'))).toBe(0);
    // Past midnight the date moves on; before 05:10 nothing is owed yet.
    expect(await gauge(await localInstant(NEW_YORK, '2026-09-21', '00:01:00'))).toBe(0);
    // At 05:10 the 21st is owed, and the 20th's job is not it.
    const now = await localInstant(NEW_YORK, '2026-09-21', '05:10:00');
    expect(await readingOf(alpha, now)).toMatchObject({ businessDate: '2026-09-21', missing: true });
    expect(await gauge(now)).toBe(1);
  });

  it('does not count a completed job under another algorithm version', async () => {
    await build(alpha, keyFor('alpha', '2026-09-21', 'today.0'));
    expect(await gauge(await localInstant(NEW_YORK, '2026-09-21', '06:00:00'))).toBe(1);
  });

  it('does not count another workspace’s job, even under the same key', async () => {
    await database.session.query("DELETE FROM jobs WHERE kind = 'today.build' AND workspace_id = $1", [beta]);
    await build(beta, keyFor('alpha', '2026-09-21'));
    const now = await localInstant(NEW_YORK, '2026-09-21', '06:00:00');
    expect(await readingOf(alpha, now)).toMatchObject({ built: false, missing: true });
    // Put Tokyo's builds back for the cases after this one.
    await database.session.query("DELETE FROM jobs WHERE kind = 'today.build' AND workspace_id = $1", [beta]);
    for (const date of ['2026-09-20', '2026-09-21', '2026-09-22']) await build(beta, keyFor('beta', date));
  });

  it('reads each workspace in its own zone and on its own business date', async () => {
    await database.session.query("DELETE FROM jobs WHERE kind = 'today.build' AND workspace_id = $1", [beta]);

    // 08:00Z on the 21st: 04:00 in New York, not yet owed; 17:00 in Tokyo, owed.
    const morning = '2026-09-21T08:00:00.000Z';
    expect(await readingOf(alpha, morning)).toMatchObject({ businessDate: '2026-09-21', due: false, missing: false });
    expect(await readingOf(beta, morning)).toMatchObject({ businessDate: '2026-09-21', due: true, missing: true });
    expect(await gauge(morning)).toBe(1);

    await build(beta, keyFor('beta', '2026-09-21'));
    expect(await gauge(morning)).toBe(0);

    // 20:30Z on the 21st: 16:30 on the 21st in New York, 05:30 on the 22nd in Tokyo.
    // Tokyo's 21st is done and does not count for its 22nd.
    await build(alpha, keyFor('alpha', '2026-09-21'));
    const evening = '2026-09-21T20:30:00.000Z';
    expect(await readingOf(alpha, evening)).toMatchObject({ businessDate: '2026-09-21', missing: false });
    expect(await readingOf(beta, evening)).toMatchObject({ businessDate: '2026-09-22', due: true, missing: true });
    expect(await gauge(evening)).toBe(1);

    await build(beta, keyFor('beta', '2026-09-22'));
    expect(await gauge(evening)).toBe(0);
  });

  it('moves the deadline with the zone when the zone changes', async () => {
    await build(alpha, keyFor('alpha', '2026-09-21'));
    // 09:30Z is 05:30 in New York (built) and 02:30 in Los Angeles (not yet owed).
    const now = '2026-09-21T09:30:00.000Z';
    expect(await readingOf(alpha, now)).toMatchObject({ due: true, built: true, missing: false });
    await database.session.query("UPDATE workspaces SET business_time_zone = 'America/Los_Angeles' WHERE id = $1", [alpha]);
    try {
      expect(await readingOf(alpha, now)).toMatchObject({ businessDate: '2026-09-21', due: false, missing: false });
      expect(await readingOf(alpha, '2026-09-21T12:10:00.000Z')).toMatchObject({ due: true, built: true, missing: false });
    } finally {
      await database.session.query('UPDATE workspaces SET business_time_zone = $2 WHERE id = $1', [alpha, NEW_YORK]);
    }
  });

  it('publishes a datum every sink accepts: a known name, a plain number, no dimension', async () => {
    const data = await collectTodayMetrics(database.session, { now: '2026-09-21T10:00:00.000Z' });
    expect(data).toHaveLength(1);
    expect(data[0]?.dimensions).toBeUndefined();
    const sink = recordingMetricSink();
    await sink.publish(data);
    expect(sink.published.map(datum => datum.name)).toEqual(['TodaySnapshotMissing']);
  });
});
