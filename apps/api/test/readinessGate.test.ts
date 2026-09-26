import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { clientVersionPolicySchema } from '@fss/contracts';
import { createApiServer } from '../src/server.ts';
import { DatabaseBusyError, poolConnections, type RequestConnections } from '../src/bootstrap/connections.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import type { NotReadyReason, ReadinessReport } from '../src/bootstrap/readiness.ts';
import {
  READINESS_EXEMPT_PATHS,
  READINESS_GATE_TTL_MILLISECONDS,
  createReadinessGate,
} from '../src/bootstrap/readinessGate.ts';
import { testRequestPool } from './support/poolFixture.ts';

/**
 * Readiness on the request path (lane g86, the other half of audit S14).
 *
 * Lane g81 pointed the load balancer at `/readyz`, and the audit's other half stayed
 * open: an ordinary request still ran its route on a task whose own readiness check
 * failed. These tests hold the gate to three promises.
 *
 * 1. A task that is not ready runs no route: every path but `/healthz`, `/readyz`,
 *    `/health` and `/auth/client-version` answers 503 `not_ready`.
 * 2. It costs no database round trip per request: the verdict is cached for a few
 *    seconds, and requests that find it stale together share one check.
 * 3. A busy pool is not a verdict: it is answered `database_busy`, and nothing is cached.
 *
 * The vacuous-pass trap is a gate that is never consulted, which passes every "ready"
 * test. So the server tests below start a real server against a real database whose
 * generation is not the pinned one, and require the refusal on a route that would
 * otherwise have answered — and the counting tests require the check to have run at
 * all, not merely no more than once.
 */

const NO_SESSION: SessionQueryable = {
  query: () => Promise.reject(new Error('the gate must not use the session while its verdict is fresh')),
};

function report(reason: NotReadyReason | null): ReadinessReport {
  return {
    ready: reason === null,
    component: 'api',
    reason,
    schema: { declaredRange: { minimum: 1, maximum: 1 }, databaseVersion: 1, accepted: reason !== 'schema_out_of_range', reason: null },
    generation: { expected: null, observed: 1, matches: reason !== 'system_generation_mismatch' },
  };
}

describe('the readiness gate', () => {
  function gateAnswering(answers: (NotReadyReason | null)[]) {
    let clock = 1_000_000;
    let checks = 0;
    const log = recordingLogger();
    const gate = createReadinessGate({
      expectedSystemGeneration: null,
      now: () => clock,
      log,
      check: async () => {
        const answer = answers[Math.min(checks, answers.length - 1)] ?? null;
        checks += 1;
        return await Promise.resolve(report(answer));
      },
    });
    return {
      gate,
      log,
      checks: () => checks,
      advance: (milliseconds: number) => {
        clock += milliseconds;
      },
    };
  }

  it('never checks for the four exempt paths, whatever the database says', async () => {
    const world = gateAnswering(['system_generation_mismatch']);
    for (const path of ['/healthz', '/readyz', '/health', '/auth/client-version']) {
      await expect(world.gate.admit(path, NO_SESSION)).resolves.toEqual({ admitted: true });
    }
    expect(READINESS_EXEMPT_PATHS).toEqual(['/healthz', '/readyz', '/health', '/auth/client-version']);
    expect(world.checks()).toBe(0);
  });

  it('checks once per window, and not again until the window has passed', async () => {
    const world = gateAnswering([null]);
    const session: SessionQueryable = { query: () => Promise.reject(new Error('the fake check reads nothing')) };
    await expect(world.gate.admit('/today', session)).resolves.toEqual({ admitted: true });
    expect(world.checks()).toBe(1);

    world.advance(READINESS_GATE_TTL_MILLISECONDS - 1);
    for (const path of ['/today', '/firms', '/pipeline/board']) {
      await expect(world.gate.admit(path, NO_SESSION)).resolves.toEqual({ admitted: true });
    }
    expect(world.checks()).toBe(1);

    world.advance(1);
    await expect(world.gate.admit('/today', session)).resolves.toEqual({ admitted: true });
    expect(world.checks()).toBe(2);
    // A few seconds, not a minute: a task that turned unfit keeps serving for one window at most.
    expect(READINESS_GATE_TTL_MILLISECONDS).toBeLessThanOrEqual(10_000);
  });

  it('shares one check between requests that find the verdict stale together', async () => {
    let release: () => void = () => undefined;
    let checks = 0;
    const gate = createReadinessGate({
      expectedSystemGeneration: null,
      check: async () => {
        checks += 1;
        await new Promise<void>(resolve => {
          release = resolve;
        });
        return report(null);
      },
    });
    const waiting = Promise.all([gate.admit('/a', NO_SESSION), gate.admit('/b', NO_SESSION), gate.admit('/c', NO_SESSION)]);
    await Promise.resolve();
    release();
    await expect(waiting).resolves.toEqual([{ admitted: true }, { admitted: true }, { admitted: true }]);
    expect(checks).toBe(1);
  });

  it('refuses with the reason, caches the refusal too, and says when the answer changes', async () => {
    const world = gateAnswering(['system_generation_mismatch', 'schema_out_of_range', null]);
    await expect(world.gate.admit('/today', NO_SESSION)).resolves.toEqual({
      admitted: false,
      reason: 'system_generation_mismatch',
    });
    await expect(world.gate.admit('/firms', NO_SESSION)).resolves.toEqual({
      admitted: false,
      reason: 'system_generation_mismatch',
    });
    expect(world.checks()).toBe(1);

    world.advance(READINESS_GATE_TTL_MILLISECONDS);
    await expect(world.gate.admit('/today', NO_SESSION)).resolves.toEqual({ admitted: false, reason: 'schema_out_of_range' });
    world.advance(READINESS_GATE_TTL_MILLISECONDS);
    await expect(world.gate.admit('/today', NO_SESSION)).resolves.toEqual({ admitted: true });
    world.advance(READINESS_GATE_TTL_MILLISECONDS);
    await expect(world.gate.admit('/today', NO_SESSION)).resolves.toEqual({ admitted: true });

    const changes = world.log.lines.filter(line => line['event'] === 'api_readiness_changed');
    expect(changes).toEqual([
      expect.objectContaining({ level: 'warn', ready: false, reason: 'system_generation_mismatch' }),
      expect.objectContaining({ level: 'warn', ready: false, reason: 'schema_out_of_range' }),
      expect.objectContaining({ level: 'info', ready: true, reason: null }),
    ]);
  });

  it('treats a busy pool as no verdict: it throws database_busy and caches nothing', async () => {
    const world = gateAnswering(['database_busy', null]);
    await expect(world.gate.admit('/today', NO_SESSION)).rejects.toBeInstanceOf(DatabaseBusyError);
    // Asked again straight away, with no time passing: the busy answer was not kept.
    await expect(world.gate.admit('/today', NO_SESSION)).resolves.toEqual({ admitted: true });
    expect(world.checks()).toBe(2);
  });

  it('refuses when the database does not answer, and trusts no verdict from a clock that went backwards', async () => {
    const world = gateAnswering([null, 'database_unreachable']);
    await expect(world.gate.admit('/today', NO_SESSION)).resolves.toEqual({ admitted: true });
    world.advance(-1);
    await expect(world.gate.admit('/today', NO_SESSION)).resolves.toEqual({ admitted: false, reason: 'database_unreachable' });
    expect(world.checks()).toBe(2);
  });
});

/**
 * Connections that count the readiness check's first statement, so a test can tell a
 * cached verdict from a fresh one on the real server.
 */
function countingChecks(inner: RequestConnections): { readonly connections: RequestConnections; readonly checks: () => number } {
  let checks = 0;
  return {
    connections: {
      checkout: async () => {
        const lease = await inner.checkout();
        return {
          session: {
            async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
              if (text.includes("to_regclass('public.system_generations')")) checks += 1;
              return await lease.session.query<Row>(text, values);
            },
          },
          release: () => {
            lease.release();
          },
        };
      },
    },
    checks: () => checks,
  };
}

describe('the API server refuses every route but the four while it is not ready', () => {
  let database: TestDatabase;
  let behind: TestDatabase;
  const pools: pg.Pool[] = [];
  const closers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    behind = await createTestDatabase({ throughVersion: 0 });
  });

  afterAll(async () => {
    for (const close of closers) await close();
    for (const pool of pools) await pool.end();
    await database.drop();
    await behind.drop();
  });

  async function serve(on: TestDatabase, expectedSystemGeneration: number | null) {
    const pool = testRequestPool(on);
    pools.push(pool);
    const counted = countingChecks(poolConnections(pool));
    const log = recordingLogger();
    const server = createApiServer({
      connections: counted.connections,
      expectedSystemGeneration,
      supportedClientVersions: clientVersionPolicySchema.parse({ minimum: '1.0.0', ceiling: '1.x', incompatible: [] }),
      sendingEnabled: false,
      log,
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    closers.push(async () => await new Promise<void>(resolve => server.close(() => resolve())));
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return { origin, log, checks: counted.checks };
  }

  const NOT_READY = {
    error: 'not_ready',
    message: 'The API is not ready to serve requests. Nothing was changed; try again shortly.',
  };

  it('answers 503 not_ready on a database whose generation is not the pinned one, and runs no route', async () => {
    const { origin, log } = await serve(database, 999_999);

    const read = await fetch(`${origin}/firms`);
    expect(read.status).toBe(503);
    expect(await read.json()).toEqual(NOT_READY);

    // A command that would otherwise have been refused 401 for want of a session is not
    // even authenticated: the task that is not ready runs nothing.
    const command = await fetch(`${origin}/admin/jobs/requeue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'x', reason: 'y' }),
    });
    expect(command.status).toBe(503);
    expect(await command.json()).toEqual(NOT_READY);

    expect(log.lines).toContainEqual(
      expect.objectContaining({
        event: 'refusal',
        reason: 'not_ready',
        code: 'not_ready',
        path: '/firms',
        not_ready_reason: 'system_generation_mismatch',
      }),
    );
    expect(log.lines.filter(line => line['event'] === 'api_readiness_changed')).toEqual([
      expect.objectContaining({ level: 'warn', ready: false, reason: 'system_generation_mismatch' }),
    ]);

    // The four that answer anyway.
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    const readiness = await fetch(`${origin}/readyz`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({ ready: false, reason: 'system_generation_mismatch' });
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    const notice = await fetch(`${origin}/auth/client-version`);
    expect(notice.status).toBe(200);
    expect(await notice.json()).toMatchObject({ supported: { minimum: '1.0.0', maximum: '1.999.999' } });
  });

  it('answers 503 not_ready on a database behind the binary', async () => {
    const { origin, log } = await serve(behind, null);
    const read = await fetch(`${origin}/firms`);
    expect(read.status).toBe(503);
    expect(await read.json()).toEqual(NOT_READY);
    expect(log.lines).toContainEqual(expect.objectContaining({ event: 'refusal', not_ready_reason: 'schema_out_of_range' }));
  });

  it('serves a ready task, and asks the database once for many requests inside the window', async () => {
    const { origin, checks } = await serve(database, 1);
    for (let request = 0; request < 5; request += 1) {
      const response = await fetch(`${origin}/firms`);
      // Whatever the route says without a session, it is the route that said it.
      expect(response.status).not.toBe(503);
      expect(await response.json()).not.toEqual(NOT_READY);
    }
    expect(checks()).toBe(1);
  });
});
