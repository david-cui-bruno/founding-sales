import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertAcknowledgedResponseSchema, wireDrift } from '@fss/contracts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { raiseCriticalAlert } from '@fss/domain/jobs/criticalAlerts.ts';
import { claimJobs, enqueueJob, failJob } from '@fss/domain/jobs/jobStore.ts';
import { ADMIN_JOBS_PATHS, FORBIDDEN_STATUS, routeAdminJobs } from '../src/routes/admin/jobs.ts';
import type { VerifiedPrincipal } from '../src/scope.ts';

/**
 * The admin job and alert routes.
 *
 * Specification 13.2: dead jobs "are visible to admins, and are requeueable only by an
 * audited admin command". Everything below is the "only" half: a salesperson, an
 * inactive membership, a revoked device and another workspace's admin are all refused,
 * and the refusal never says which of those it was.
 */
describe('admin job and alert routes', () => {
  let database: TestDatabase;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let adminUserId: string;
  let salespersonUserId: string;
  let deviceId: string;
  let deadJobId: string;
  let alertId: string;

  const principal = (overrides: Partial<VerifiedPrincipal> = {}): VerifiedPrincipal => ({
    workspaceId,
    userId: adminUserId,
    role: 'admin',
    membershipStatus: 'active',
    deviceId,
    deviceStatus: 'active',
    ...overrides,
  });

  beforeAll(async () => {
    database = await createTestDatabase();
    const session = database.session;

    const workspace = await session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = workspace.rows[0]?.id ?? '';
    const other = await session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('beta', 'Beta') RETURNING id",
    );
    otherWorkspaceId = other.rows[0]?.id ?? '';

    const seedUser = async (sub: string, email: string, role: 'admin' | 'salesperson', inWorkspace: string) => {
      const user = await session.query<{ id: string }>(
        'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
        [sub, email, role],
      );
      const id = user.rows[0]?.id ?? '';
      await session.query('INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
        inWorkspace,
        id,
        role,
      ]);
      return id;
    };
    adminUserId = await seedUser('sub-admin', 'admin@example.test', 'admin', workspaceId);
    salespersonUserId = await seedUser('sub-sales', 'sales@example.test', 'salesperson', workspaceId);
    await seedUser('sub-other-admin', 'other@example.test', 'admin', otherWorkspaceId);

    const device = await session.query<{ id: string }>(
      'INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [workspaceId, adminUserId, "David's MacBook", 'a'.repeat(64)],
    );
    deviceId = device.rows[0]?.id ?? '';

    // A real dead job: enqueued, claimed, failed until it is exhausted.
    await enqueueJob(session, {
      workspaceId,
      kind: 'retention.batch',
      idempotencyKey: 'retention:audit_events:2026-08',
      payload: { page: 1 },
      maxAttempts: 1,
    });
    const [claim] = await claimJobs(session, {
      owner: 'worker-1',
      kinds: ['retention.batch'],
      limit: 1,
      leaseSeconds: 30,
    });
    if (claim === undefined) throw new Error('the fixture job was not claimable');
    expect(await failJob(session, claim, { code: 'handler_failed' })).toBe('dead');
    deadJobId = claim.id;

    alertId = (await raiseCriticalAlert(session, { workspaceId, alertKey: 'dead_job_unresolved' })).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  it('owns exactly the four admin paths, and passes anything else back to the router', async () => {
    expect([...ADMIN_JOBS_PATHS]).toEqual([
      '/admin/jobs/dead',
      '/admin/jobs/requeue',
      '/admin/alerts',
      '/admin/alerts/acknowledge',
    ]);
    expect(
      await routeAdminJobs({ method: 'GET', path: '/health', principal: principal(), db: database.session }),
    ).toBeNull();
  });

  it('refuses an unauthenticated request, and says nothing about what is behind it', async () => {
    const response = await routeAdminJobs({
      method: 'GET',
      path: '/admin/jobs/dead',
      principal: null,
      db: database.session,
    });
    expect(response?.status).toBe(401);
    expect(JSON.stringify(response?.body)).not.toContain('retention');
  });

  const refusedPrincipals: readonly (readonly [string, Partial<VerifiedPrincipal>])[] = [
    ['a salesperson', { role: 'salesperson' }],
    ['an inactive membership', { membershipStatus: 'inactive' }],
    ['a revoked device', { deviceStatus: 'revoked' }],
  ];

  it.each(refusedPrincipals)('refuses the dead-job list for %s', async (_label, overrides) => {
    const who = overrides.role === 'salesperson' ? { ...overrides, userId: salespersonUserId } : overrides;
    const response = await routeAdminJobs({
      method: 'GET',
      path: '/admin/jobs/dead',
      principal: principal(who),
      db: database.session,
    });
    expect(response?.status).toBe(FORBIDDEN_STATUS);
  });

  it('lists the dead jobs for an admin', async () => {
    const response = await routeAdminJobs({
      method: 'GET',
      path: '/admin/jobs/dead',
      principal: principal(),
      db: database.session,
    });
    expect(response?.status).toBe(200);
    const body = response?.body as unknown as { deadJobs: { id: string; kind: string; errorCode: string | null }[] };
    expect(body.deadJobs).toHaveLength(1);
    expect(body.deadJobs[0]?.kind).toBe('retention.batch');
    expect(body.deadJobs[0]?.errorCode).toBe('handler_failed');
  });

  it('refuses a requeue without a job id or a reason', async () => {
    for (const body of [{}, { jobId: deadJobId }, { reason: 'because' }, { jobId: deadJobId, reason: '  ' }]) {
      const response = await routeAdminJobs({
        method: 'POST',
        path: '/admin/jobs/requeue',
        principal: principal(),
        body,
        db: database.session,
      });
      expect(response?.status).toBe(400);
    }
  });

  it('refuses the wrong method on an admin path', async () => {
    const response = await routeAdminJobs({
      method: 'GET',
      path: '/admin/jobs/requeue',
      principal: principal(),
      db: database.session,
    });
    expect(response?.status).toBe(405);
  });

  it('requeues for an admin, audits it, and refuses the second attempt', async () => {
    const response = await routeAdminJobs({
      method: 'POST',
      path: '/admin/jobs/requeue',
      principal: principal(),
      body: { jobId: deadJobId, reason: 'the provider is back' },
      db: database.session,
    });
    expect(response?.status).toBe(200);
    expect(response?.body).toEqual({ requeued: true, jobId: deadJobId, kind: 'retention.batch' });

    const audit = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1 AND action = 'job.requeue'",
      [workspaceId],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);

    // It is no longer dead, so a second requeue has nothing to act on.
    const again = await routeAdminJobs({
      method: 'POST',
      path: '/admin/jobs/requeue',
      principal: principal(),
      body: { jobId: deadJobId, reason: 'again' },
      db: database.session,
    });
    expect(again?.status).toBe(404);
  });

  it('lists and acknowledges an alert, and refuses another workspace’s admin', async () => {
    const listed = await routeAdminJobs({
      method: 'GET',
      path: '/admin/alerts',
      principal: principal(),
      db: database.session,
    });
    expect(listed?.status).toBe(200);
    const alerts = (listed?.body as unknown as { alerts: { alertKey: string }[] }).alerts;
    expect(alerts.map(alert => alert.alertKey)).toEqual([
      'dead_job_unresolved',
    ]);

    // The scope comes from the verified principal, so another workspace's admin asking
    // for this alert id simply does not find it.
    const crossed = await routeAdminJobs({
      method: 'POST',
      path: '/admin/alerts/acknowledge',
      principal: principal({ workspaceId: otherWorkspaceId }),
      body: { alertId },
      db: database.session,
    });
    expect(crossed?.status).toBe(404);

    const acknowledged = await routeAdminJobs({
      method: 'POST',
      path: '/admin/alerts/acknowledge',
      principal: principal(),
      body: { alertId, note: 'requeued the job' },
      db: database.session,
    });
    expect(acknowledged?.status).toBe(200);
    expect(acknowledged?.body).toEqual({ acknowledged: true, alertKey: 'dead_job_unresolved' });
    // The Mac reads this answer with `@fss/contracts`' schema.
    expect(wireDrift(alertAcknowledgedResponseSchema, acknowledged?.body)).toEqual([]);

    const audit = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1 AND action = 'alert.acknowledge'",
      [workspaceId],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
  });
});
