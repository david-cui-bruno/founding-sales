import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { runTwiceUnderStolenLease } from '@fss/domain/jobs/atLeastOnce.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { JOB_KIND_CLASS, hourOf, jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { CalcomBookingsClient, CalcomBookingsQuery } from '@fss/domain/meetings/reconcile.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { registerHandlers, workerDueWorkSources } from '../src/bootstrap/main.ts';
import { calcomBookingsClient, readCalcomReconcileClient, type CalcomHttp } from '../src/calcom/bookingsClient.ts';
import { calcomReconcileJobHandler, calcomReconcileSource } from '../src/handlers/calcomReconcile.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';

/**
 * The `calcom.reconcile` job, its source and its client (slice M1). The client is tested
 * against a stub `fetch` and the job against a fake client: nothing here reaches Cal.com.
 */

// Assembled at run time: no literal in the tree looks like a key (gitleaks).
const KEY = ['cal', 'live', 'FAKE', 'sentinel', '0123456789'].join('_');
const SECRET = JSON.stringify({ webhook_secret: 'w'.repeat(32), api_key: KEY });

describe('the Cal.com bookings client', () => {
  it('asks GET /v2/bookings with the bearer key, the version header, the window and the cursor', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const http: CalcomHttp = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return await Promise.resolve(
        new Response(JSON.stringify({ status: 'success', data: [{ uid: 'a1x' }], pagination: { hasMore: true, nextCursor: 'next1' } }), { status: 200 }),
      );
    };
    const page = await calcomBookingsClient({ apiKey: KEY, http }).listBookings({
      afterStart: '2026-09-24T12:00:00.000Z',
      beforeEnd: '2026-11-30T12:00:00.000Z',
      cursor: 'prev1',
      limit: 100,
      timeoutMs: 30_000,
    });
    expect(page).toEqual({ bookings: [{ uid: 'a1x' }], nextCursor: 'next1' });
    const url = new URL(seen[0]?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://api.cal.com/v2/bookings');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      afterStart: '2026-09-24T12:00:00.000Z',
      beforeEnd: '2026-11-30T12:00:00.000Z',
      limit: '100',
      cursor: 'prev1',
    });
    expect(seen[0]?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'cal-api-version': '2026-05-01' });
  });

  it('ends the walk when hasMore is false, and throws without the key on a refusal or a bad body', async () => {
    const answer = (status: number, body: unknown): CalcomHttp => async () => await Promise.resolve(new Response(JSON.stringify(body), { status }));
    const query: CalcomBookingsQuery = { afterStart: 'a', beforeEnd: 'b', cursor: null, limit: 100, timeoutMs: 30_000 };
    expect(
      await calcomBookingsClient({ apiKey: KEY, http: answer(200, { status: 'success', data: [], pagination: { hasMore: false, nextCursor: null } }) }).listBookings(query),
    ).toEqual({ bookings: [], nextCursor: null });
    for (const [status, body, message] of [
      [401, { status: 'error' }, 'calcom_http_401'],
      [200, { status: 'error', data: [] }, 'calcom_answer_unreadable'],
    ] as const) {
      const failure = await calcomBookingsClient({ apiKey: KEY, http: answer(status, body) }).listBookings(query).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(message);
      expect(JSON.stringify(failure) + String(failure)).not.toContain(KEY);
    }
    const offline = await calcomBookingsClient({ apiKey: KEY, http: async () => await Promise.reject(new Error(`boom ${KEY}`)) })
      .listBookings(query)
      .catch((error: unknown) => error);
    expect((offline as Error).message).toBe('calcom_unreachable');
  });

  it('is configured only by an api_key, and never shows it', () => {
    expect(readCalcomReconcileClient({}).problem).toBe('absent');
    expect(readCalcomReconcileClient({ calcom: JSON.stringify({ webhook_secret: 'w'.repeat(32) }) })).toEqual({ client: null, problem: 'absent' });
    const configured = readCalcomReconcileClient({ calcom: SECRET });
    expect(configured.problem).toBeNull();
    expect(JSON.stringify(configured)).not.toContain(KEY);
  });
});

describe('the calcom.reconcile job and its source', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;

  const fake = (bookings: readonly unknown[]): CalcomBookingsClient & { calls: number } => {
    const client = {
      calls: 0,
      listBookings: async () => {
        client.calls += 1;
        return await Promise.resolve({ bookings, nextCursor: null });
      },
    };
    return client;
  };

  async function switchOn(workspaceId: string, userId: string): Promise<void> {
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'calendar_integration', 1, '{"integration": "calcom"}'::jsonb, $2)`,
      [workspaceId, userId],
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is a documented source always, and a registered handler only with a key', () => {
    expect(workerDueWorkSources().map(source => source.name)).toContain('calcom-reconcile');
    const without = registerHandlers(new HandlerRegistry(), {} as Parameters<typeof registerHandlers>[1]);
    expect(without.get('calcom.reconcile')).toBeUndefined();
    const withKey = registerHandlers(new HandlerRegistry(), { calcom: { client: fake([]) } } as unknown as Parameters<typeof registerHandlers>[1]);
    expect(withKey.get('calcom.reconcile')?.protection).toBe('business_uniqueness');
    expect(JOB_KIND_CLASS['calcom.reconcile']).toBe('bulk');
  });

  it('materializes one job an hour for the one workspace switched on, and nothing without a key or with two', async () => {
    const now = new Date().toISOString();
    expect(await calcomReconcileSource({ enabled: true }).find(database.session, now)).toEqual([]);
    await switchOn(seeded.alpha.workspaceId, seeded.alpha.admin.userId);
    expect(await calcomReconcileSource({ enabled: false }).find(database.session, now)).toEqual([]);
    expect(await calcomReconcileSource({ enabled: true }).find(database.session, now)).toEqual([
      {
        workspaceId: seeded.alpha.workspaceId,
        kind: 'calcom.reconcile',
        idempotencyKey: jobIdempotencyKey.calcomReconcile('alpha', hourOf(now)),
        payload: { hour: hourOf(now) },
        maxAttempts: 3,
      },
    ]);
    // The bootstrap's own list, handed a key, carries the same source.
    const source = workerDueWorkSources({ calcomReconcile: true }).find(entry => entry.name === 'calcom-reconcile');
    expect(await source?.find(database.session, now)).toHaveLength(1);

    await switchOn(seeded.beta.workspaceId, seeded.beta.admin.userId);
    expect(await calcomReconcileSource({ enabled: true }).find(database.session, now)).toEqual([]);
    await database.session.query("DELETE FROM workspace_settings WHERE workspace_id = $1 AND setting_key = 'calendar_integration'", [
      seeded.beta.workspaceId,
    ]);
  });

  it('applies what it read once, under a stolen lease, and logs its counts', async () => {
    const lines: Record<string, unknown>[] = [];
    const client = fake([
      {
        uid: 'worker1x',
        status: 'accepted',
        start: '2026-10-06T15:00:00.000Z',
        end: '2026-10-06T15:30:00.000Z',
        createdAt: '2026-09-30T12:00:00.000Z',
        updatedAt: '2026-09-30T12:00:00.000Z',
        hosts: [{ email: 'david@usecallie.example' }],
        attendees: [{ email: 'someone@elsewhere.example', absent: false }],
      },
    ]);
    const registry = new HandlerRegistry().register(
      calcomReconcileJobHandler({ client, now: () => '2026-10-01T12:00:00.000Z', log: (event, fields) => lines.push({ event, ...fields }) }),
    );
    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry,
      run: runClaimedJob,
      workspaceId: seeded.alpha.workspaceId,
      kind: 'calcom.reconcile',
      idempotencyKey: jobIdempotencyKey.calcomReconcile('alpha', hourOf('2026-10-01T12:00:00.000Z')),
      payload: {},
      countEffects: async () => {
        const { rows } = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM meetings WHERE workspace_id = $1', [
          seeded.alpha.workspaceId,
        ]);
        return Number(rows[0]?.count);
      },
    });
    expect(report.freshOutcome).toBe('completed');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
    expect(lines.find(line => line['event'] === 'calcom_reconcile')).toMatchObject({ bookings: 1, synthesized: 1, unmatched: 1, pages: 1, truncated: false });
    expect(JSON.stringify(lines)).not.toContain('someone@elsewhere.example');
  });

  it('does nothing when the switch moved after the job was queued, before the fetch or before the apply (fold 1, finding 4)', async () => {
    const lines: Record<string, unknown>[] = [];
    const booking = {
      uid: 'routed1x',
      status: 'accepted',
      start: '2026-10-06T15:00:00.000Z',
      end: '2026-10-06T15:30:00.000Z',
      createdAt: '2026-09-30T12:00:00.000Z',
      updatedAt: '2026-09-30T12:00:00.000Z',
      attendees: [{ email: 'routed@elsewhere.example', absent: false }],
    };
    const meetingsIn = async (workspaceId: string): Promise<number> => {
      const { rows } = await database.session.query<{ count: string }>("SELECT count(*) AS count FROM meetings WHERE workspace_id = $1 AND booking_uid = 'routed1x'", [
        workspaceId,
      ]);
      return Number(rows[0]?.count);
    };
    const run = async (client: CalcomBookingsClient, hour: string): Promise<string | undefined> => {
      const registry = new HandlerRegistry().register(
        calcomReconcileJobHandler({ client, now: () => '2026-10-01T12:00:00.000Z', log: (event, fields) => lines.push({ event, ...fields }) }),
      );
      const report = await runTwiceUnderStolenLease({
        session: database.session,
        registry,
        run: runClaimedJob,
        workspaceId: seeded.alpha.workspaceId,
        kind: 'calcom.reconcile',
        idempotencyKey: jobIdempotencyKey.calcomReconcile('alpha', hour),
        payload: {},
        countEffects: async () => await meetingsIn(seeded.alpha.workspaceId),
      });
      return report.freshOutcome;
    };

    // Queued for alpha, but by the time it runs alpha's switch is off and beta's is on.
    await database.session.query("DELETE FROM workspace_settings WHERE workspace_id = $1 AND setting_key = 'calendar_integration'", [
      seeded.alpha.workspaceId,
    ]);
    await switchOn(seeded.beta.workspaceId, seeded.beta.admin.userId);
    const untouched = fake([booking]);
    expect(await run(untouched, '2026-10-01T10:00:00.000Z')).toBe('completed');
    expect(untouched.calls).toBe(0);
    expect(lines.at(-1)).toMatchObject({ event: 'calcom_reconcile_skipped', stage: 'before_fetch' });

    // Routed to alpha when it starts, moved while the page was on the wire.
    await database.session.query("DELETE FROM workspace_settings WHERE workspace_id = $1 AND setting_key = 'calendar_integration'", [seeded.beta.workspaceId]);
    await switchOn(seeded.alpha.workspaceId, seeded.alpha.admin.userId);
    const moving: CalcomBookingsClient = {
      listBookings: async () => {
        await switchOn(seeded.beta.workspaceId, seeded.beta.admin.userId);
        return { bookings: [booking], nextCursor: null };
      },
    };
    expect(await run(moving, '2026-10-01T11:00:00.000Z')).toBe('completed');
    // The stolen-lease rerun then finds the switch moved already and stops before fetching.
    expect(lines.filter(line => line['event'] === 'calcom_reconcile_skipped').map(line => line['stage'])).toContain('before_apply');
    expect(lines.some(line => line['event'] === 'calcom_reconcile')).toBe(false);
    expect(await meetingsIn(seeded.alpha.workspaceId)).toBe(0);
    expect(await meetingsIn(seeded.beta.workspaceId)).toBe(0);
  });
});
