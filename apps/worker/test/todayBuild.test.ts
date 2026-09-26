import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { runTwiceUnderStolenLease } from '@fss/domain/jobs/atLeastOnce.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { readTodayList } from '@fss/domain/today/dto.ts';
import { businessDateOf } from '@fss/domain/today/snapshots.ts';
import { TODAY_ALGORITHM_VERSION } from '@fss/domain/today/types.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import {
  TODAY_BUILD_LOCAL_MINUTE,
  todayBuildJobHandler,
  todayBuildJobKey,
  todayBuildSource,
} from '../src/handlers/todayBuild.ts';

/**
 * The `today.build` job (Appendix C, specification 8.2, 13.1, 13.3, Appendix G 1
 * and 2).
 *
 * Three things are proved here and nowhere else.
 *
 * **The registry accepts it under Appendix C's protection and no other.** The table
 * says `business_uniqueness` for this kind, and `HandlerRegistry.register` refuses a
 * declaration that disagrees.
 *
 * **One job per workspace per business date, whatever the pass does.** Appendix G 1:
 * "Two scheduler transactions synchronized over one due execution create one job row;
 * repeat for Today". Here it is two passes a minute apart and one row.
 *
 * **It produces one effect under a real stolen lease.** `docs/greenfield/jobs.md`
 * makes that probe mandatory for every lane that registers a handler.
 *
 * No real business name appears; `example.test` is reserved by RFC 6761.
 */
describe('the Today build as a job', () => {
  let database: TestDatabase;
  let workspaceId: string;
  let slug = '';
  let userId: string;
  let businessDate = '';
  let now = '';

  beforeAll(async () => {
    database = await createTestDatabase();
    const workspace = await database.session.query<{ id: string; slug: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id, slug",
    );
    workspaceId = workspace.rows[0]?.id ?? '';
    slug = workspace.rows[0]?.slug ?? '';
    const user = await database.session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-today', 'today@example.test', 'Today') RETURNING id",
    );
    userId = user.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [workspaceId, userId],
    );
    await database.session.query(
      "INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, 'Northwind Test Holdings', $2)",
      [workspaceId, userId],
    );
    const clock = await database.session.query<{ now: Date }>('SELECT now() AS now');
    now = (clock.rows[0]?.now ?? new Date()).toISOString();
    businessDate = await businessDateOf(worker(), now);
  });

  afterAll(async () => {
    await database.drop();
  });

  const worker = () =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), database.session);
  const salesperson = () =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role: 'salesperson' }), database.session);

  /** 05:00 local on the workspace's current business date, as a UTC instant. */
  const atFiveLocal = async (): Promise<string> => {
    const { rows } = await database.session.query<{ at: Date }>(
      `SELECT (($2::date + TIME '05:00') AT TIME ZONE w.business_time_zone) AS at
         FROM workspaces w WHERE w.id = $1`,
      [workspaceId, businessDate],
    );
    return (rows[0]?.at ?? new Date()).toISOString();
  };

  it('registers under the protection Appendix C names, and refuses any other', () => {
    const registry = new HandlerRegistry().register(todayBuildJobHandler());
    expect(registry.kinds()).toContain('today.build');
    expect(registry.get('today.build')?.protection).toBe('business_uniqueness');
    expect(() =>
      new HandlerRegistry().register({ ...todayBuildJobHandler(), protection: 'fencing_token' }),
    ).toThrow(/business_uniqueness/);
  });

  it('names the workspace, the business date and the algorithm in its key', () => {
    expect(todayBuildJobKey(slug, '2026-09-21')).toBe(`today:${slug}:2026-09-21:${TODAY_ALGORITHM_VERSION}`);
    expect(TODAY_BUILD_LOCAL_MINUTE).toBe(300);
  });

  it('materializes one job per workspace per business date, however many passes run', async () => {
    const at = await atFiveLocal();
    for (const offsetMinutes of [0, 1, 240]) {
      const report = await runSchedulerPass(database.session, {
        sources: [todayBuildSource()],
        now: new Date(Date.parse(at) + offsetMinutes * 60_000).toISOString(),
        instanceKey: `pass-${String(offsetMinutes)}`,
      });
      expect(report.outcome).toBe('ran');
    }
    const { rows } = await database.session.query<{ idempotency_key: string; payload: { businessDate: string } }>(
      "SELECT idempotency_key, payload FROM jobs WHERE workspace_id = $1 AND kind = 'today.build'",
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotency_key).toBe(todayBuildJobKey(slug, businessDate));
    expect(rows[0]?.payload.businessDate).toBe(businessDate);
  });

  it('materializes nothing before 05:00 in the workspace zone', async () => {
    const before = new Date(Date.parse(await atFiveLocal()) - 60 * 60 * 1000).toISOString();
    const report = await runSchedulerPass(database.session, {
      sources: [todayBuildSource()],
      now: before,
      instanceKey: 'pass-early',
    });
    expect(report.outcome).toBe('ran');
    expect(report.inserted).toBe(0);
  });

  it('builds one list when a stolen lease makes it run twice', async () => {
    await database.session.query("DELETE FROM jobs WHERE workspace_id = $1 AND kind = 'today.build'", [workspaceId]);

    const registry = new HandlerRegistry().register(todayBuildJobHandler());
    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry,
      run: runClaimedJob,
      workspaceId,
      kind: 'today.build',
      idempotencyKey: todayBuildJobKey(slug, businessDate),
      payload: { businessDate, algorithmVersion: TODAY_ALGORITHM_VERSION },
      countEffects: async () => {
        const { rows } = await database.session.query<{ count: string }>(
          'SELECT count(*) AS count FROM today_items WHERE workspace_id = $1',
          [workspaceId],
        );
        return Number(rows[0]?.count);
      },
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    // One firm, one new-firm task; the woken worker adds nothing.
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
    expect(report.freshFencingToken).not.toBe(report.staleFencingToken);

    const list = await readTodayList(salesperson(), { now });
    expect(list.cards).toHaveLength(1);
    expect(list.cards[0]?.lane).toBe('new_firm');
  });

  it('refuses a payload built for another algorithm rather than building the wrong list', async () => {
    const handler = todayBuildJobHandler();
    await expect(
      handler.handle({
        session: database.session,
        scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
        job: {
          id: '00000000-0000-4000-8000-000000000000',
          workspaceId,
          kind: 'today.build',
          idempotencyKey: todayBuildJobKey(slug, businessDate),
          payload: { businessDate, algorithmVersion: 'today.99' },
          attempt: 1,
          maxAttempts: 4,
          fencingToken: '1',
          leaseOwner: 'test',
          leaseExpiresAt: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow(/today\.99/);
  });

  it('refuses a payload with no business date', async () => {
    const handler = todayBuildJobHandler();
    await expect(
      handler.handle({
        session: database.session,
        scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
        job: {
          id: '00000000-0000-4000-8000-000000000000',
          workspaceId,
          kind: 'today.build',
          idempotencyKey: 'today:alpha:x:today.1',
          payload: {},
          attempt: 1,
          maxAttempts: 4,
          fencingToken: '1',
          leaseOwner: 'test',
          leaseExpiresAt: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow(/business date/);
  });

  it('is what the worker process registers and schedules', async () => {
    const { main } = await import('../src/bootstrap/main.ts');
    expect(typeof main).toBe('function');
    // The composition itself is asserted by `workerProcess.test.ts`; what matters
    // here is that the handler and the source are exported for it to compose.
    expect(todayBuildSource().name).toBe('today-build');
  });
});
