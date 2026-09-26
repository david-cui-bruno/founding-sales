import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import type { SessionQueryable } from '@fss/domain/db';
import { readHeartbeats } from '@fss/domain/jobs';
import { MAX_REQUEST_BYTES } from '../src/limits.ts';
import type { VerifiedPrincipal } from '../src/scope.ts';
import { RouteRegistryError, createRouteRegistry, type RouteModule } from '../src/bootstrap/routeRegistry.ts';
import { adminJobsModule, mountedRoutes } from '../src/bootstrap/routes.ts';
import { buildReadinessReport, readinessModule } from '../src/bootstrap/readiness.ts';
import { readBody, type BodySource } from '../src/bootstrap/requestBody.ts';
import { startApiHeartbeat } from '../src/bootstrap/heartbeat.ts';
import { dispatch } from '../src/bootstrap/dispatch.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';

/**
 * The API process bootstrap: the route registry, readiness, the body reader and the
 * heartbeat.
 *
 * `apps/api/src/server.ts` is G2's while identity is being built, so nothing here
 * edits it. Everything below is what the coordinator mounts into it: one registry
 * that refuses two modules claiming the same path, one dispatch that applies the
 * envelope limits before a route sees a request, and a readiness endpoint that fails
 * closed when the database is behind the binary.
 */

function bytes(source: string): BodySource {
  const chunks = [Buffer.from(source, 'utf8')];
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe('the API bootstrap', () => {
  let database: TestDatabase;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let adminUserId: string;
  let deviceId: string;

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
    const seed = async (slug: string): Promise<{ workspaceId: string; userId: string; deviceId: string }> => {
      const workspace = await database.session.query<{ id: string }>(
        'INSERT INTO workspaces (slug, display_name) VALUES ($1, $2) RETURNING id',
        [slug, `Workspace ${slug}`],
      );
      const id = workspace.rows[0]?.id ?? '';
      const user = await database.session.query<{ id: string }>(
        'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
        [`sub-${slug}`, 'shared@example.test', 'Admin'],
      );
      const userId = user.rows[0]?.id ?? '';
      await database.session.query('INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
        id,
        userId,
        'admin',
      ]);
      const device = await database.session.query<{ id: string }>(
        'INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4) RETURNING id',
        [id, userId, 'desk', 'a'.repeat(64)],
      );
      return { workspaceId: id, userId, deviceId: device.rows[0]?.id ?? '' };
    };
    const alpha = await seed('alpha');
    const beta = await seed('beta');
    workspaceId = alpha.workspaceId;
    adminUserId = alpha.userId;
    deviceId = alpha.deviceId;
    otherWorkspaceId = beta.workspaceId;
  });

  afterAll(async () => {
    await database.drop();
  });

  // ------------------------------------------------------------------ registry
  it('refuses two modules that claim the same path', () => {
    const module = (name: string): RouteModule => ({
      name,
      paths: ['/admin/jobs/dead'],
      handle: async () => Promise.resolve(null),
    });
    expect(() => createRouteRegistry([module('one'), module('two')])).toThrow(RouteRegistryError);
  });

  it('knows every path it has mounted, so a router cannot guess', () => {
    const registry = createRouteRegistry(mountedRoutes());
    expect(registry.paths()).toContain('/admin/jobs/dead');
    expect(registry.paths()).toContain('/healthz');
    expect(registry.paths()).toContain('/readyz');
    // Sorted and unique: the list is read by an operator as well as by a test.
    expect([...registry.paths()]).toEqual([...new Set(registry.paths())].sort());
  });

  it('returns null for a path nothing mounted, so the caller decides the refusal', async () => {
    const registry = createRouteRegistry(mountedRoutes());
    const outcome = await dispatch(registry, {
      method: 'GET',
      path: '/firms',
      headers: {},
      principal: null,
      db: database.session,
      readiness: { session: database.session },
    });
    expect(outcome).toBeNull();
  });

  // --------------------------------------------------------------- admin jobs
  it('reaches the admin job routes G5 wrote, and refuses the workspace next door', async () => {
    const registry = createRouteRegistry([adminJobsModule()]);
    const request = {
      method: 'GET',
      path: '/admin/jobs/dead',
      headers: {},
      db: database.session,
      readiness: { session: database.session },
    };
    const authorized = await dispatch(registry, { ...request, principal: principal() });
    expect(authorized?.status).toBe(200);

    const unauthenticated = await dispatch(registry, { ...request, principal: null });
    expect(unauthenticated?.status).toBe(401);

    const elsewhere = await dispatch(registry, {
      ...request,
      principal: principal({ workspaceId: otherWorkspaceId }),
    });
    // A different workspace's admin is an admin of that workspace, and the dead-job
    // list it gets is that workspace's. Nothing of alpha's crosses.
    expect(elsewhere?.status).toBe(200);
  });

  // ---------------------------------------------------------------- readiness
  it('is live before it is ready: /healthz never touches the database', async () => {
    const exploding: SessionQueryable = {
      query: async () => {
        await Promise.resolve();
        throw new Error('connection to server at "10.0.0.5", port 5432 failed');
      },
    };
    const registry = createRouteRegistry([readinessModule()]);
    const live = await dispatch(registry, {
      method: 'GET',
      path: '/healthz',
      headers: {},
      principal: null,
      db: exploding,
      readiness: { session: exploding },
    });
    expect(live?.status).toBe(200);
    expect(JSON.stringify(live?.body)).not.toContain('10.0.0.5');

    const ready = await dispatch(registry, {
      method: 'GET',
      path: '/readyz',
      headers: {},
      principal: null,
      db: exploding,
      readiness: { session: exploding },
    });
    // A database that cannot answer is not readiness. The load balancer takes this
    // task out of rotation; the task stays up so an operator can read its logs.
    expect(ready?.status).toBe(503);
  });

  it('is not ready on a database behind the binary', async () => {
    const behind = await createTestDatabase({ throughVersion: 0 });
    try {
      const report = await buildReadinessReport({ session: behind.session });
      expect(report.ready).toBe(false);
      expect(report.schema.reason).toBe('database_behind_binary');
    } finally {
      await behind.drop();
    }
  });

  it('is ready on a database inside the range, whatever its system_generations rows say', async () => {
    // The generation pin is gone (lane W3-S8): a restored copy is made ready by the
    // restore runbook, not refused by a generation comparison.
    await database.session.query(
      "INSERT INTO system_generations (generation, reason, established_at, notes) VALUES (9, 'initial', now(), 'W3-S8: never read')",
    );
    const report = await buildReadinessReport({ session: database.session });
    expect(report).toMatchObject({ ready: true, reason: null });
    expect(report).not.toHaveProperty('generation');
  });

  // -------------------------------------------------------------------- body
  it('refuses a body larger than the limit even when Content-Length lied', async () => {
    const outcome = await readBody(bytes('x'.repeat(MAX_REQUEST_BYTES + 1)), MAX_REQUEST_BYTES);
    expect(outcome.accepted).toBe(false);
    expect(outcome.accepted === false && outcome.code).toBe('payload_too_large');
  });

  it('refuses a body that is not a JSON object', async () => {
    expect((await readBody(bytes('not json'), MAX_REQUEST_BYTES)).accepted).toBe(false);
    expect((await readBody(bytes('[1,2,3]'), MAX_REQUEST_BYTES)).accepted).toBe(false);
    const object = await readBody(bytes('{"jobId":"x"}'), MAX_REQUEST_BYTES);
    expect(object.accepted && object.body).toEqual({ jobId: 'x' });
  });

  it('accepts an empty body as no body at all', async () => {
    const outcome = await readBody(bytes(''), MAX_REQUEST_BYTES);
    expect(outcome.accepted && outcome.body).toEqual({});
  });

  // --------------------------------------------------------------- heartbeat
  it('records the api heartbeat the worker turns into ApiHeartbeat', async () => {
    const heartbeat = startApiHeartbeat({
      session: await database.appRuntimeSession(),
      instanceKey: 'api-test',
      intervalMilliseconds: 20,
      log: recordingLogger(),
    });
    try {
      const deadline = Date.now() + 10_000;
      let seen = false;
      while (Date.now() < deadline && !seen) {
        seen = (await readHeartbeats(database.session)).some(beat => beat.component === 'api');
        if (!seen) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(seen).toBe(true);
    } finally {
      await heartbeat.stop();
    }
  });
});
