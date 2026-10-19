import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { readPhoneHandoffResult, reservePhoneHandoff } from '../../dial/phoneHandoff.ts';
import { phoneFixture, type PhoneFixture } from './phoneHandoffFixtures.ts';

let database: TestDatabase;
let f: PhoneFixture;
beforeEach(async () => { database = await createTestDatabase(); f = await phoneFixture(database); await f.publish(); });
afterEach(async () => { await database.drop(); });

async function connection() {
  const session = await database.appRuntimeSession();
  await session.query("SET statement_timeout='8s'");
  const pid = (await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  if (!pid) throw new Error('missing backend pid');
  return { session, pid };
}

async function waitsOn(waiter: number, blocker: number) {
  await expect.poll(async () => (await database.session.query<{ blocked: boolean }>(
    'SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [blocker, waiter])).rows[0]?.blocked,
  { timeout: 4000 }).toBe(true);
}

async function revoke(session: SessionQueryable, kind: 'device' | 'membership') {
  if (kind === 'device') {
    await session.query("UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
      [f.w, f.seeded.alpha.salesperson.deviceId]);
    await session.query("UPDATE sessions SET status='ended',ended_at=clock_timestamp(),end_reason='device_revoked' WHERE workspace_id=$1 AND device_id=$2 AND status='active'",
      [f.w, f.seeded.alpha.salesperson.deviceId]);
  } else {
    await session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",
      [f.w, f.seeded.alpha.salesperson.userId]);
  }
}

async function reserve(session: SessionQueryable) {
  return await reservePhoneHandoff(repositoryContext(f.context.scope, session), f.request());
}

/** Only the decision clocks are injected; all locks, waits, reads and writes use PostgreSQL. */
function decisionClocks(session: SessionQueryable, decisionAt: string, finalAt: string): SessionQueryable {
  return {
    async query(text, values) {
      if (text === 'SELECT clock_timestamp() AS at') return await session.query('SELECT $1::timestamptz AS at', [finalAt]);
      if (text.includes('clock_timestamp()') && text.includes(' AS at')) {
        return await session.query(text.replace('clock_timestamp()', '$1::timestamptz'), [decisionAt]);
      }
      return await session.query(text, values);
    },
  };
}

describe('phone handoff authority through reservation commit', () => {
  it.each(['device', 'membership'] as const)('refuses when %s revocation commits during a registry wait', async kind => {
    const registry = await connection();
    const admission = await connection();
    await registry.session.query('BEGIN');
    await registry.session.query('SELECT id FROM national_registry_snapshots WHERE workspace_id=$1 FOR UPDATE', [f.w]);
    const pending = withTransaction(admission.session, async () => await reserve(admission.session));
    try {
      await waitsOn(admission.pid, registry.pid);
      await withTransaction(database.session, async () => await revoke(database.session, kind));
    } finally { await registry.session.query('ROLLBACK'); }
    expect(await pending).toEqual({ ok: false, reason: 'phone_handoff_unavailable' });
    expect((await database.session.query('SELECT id FROM phone_handoff_attempts WHERE workspace_id=$1', [f.w])).rows).toHaveLength(0);
  });

  it.each(['device', 'membership'] as const)('holds the %s authority row until an admitted reservation commits', async kind => {
    const admission = await connection();
    const revocation = await connection();
    await admission.session.query('BEGIN');
    const result = await reserve(admission.session);
    expect(result.ok).toBe(true);
    const pending = withTransaction(revocation.session, async () => await revoke(revocation.session, kind));
    try {
      await waitsOn(revocation.pid, admission.pid);
      expect((await database.session.query('SELECT id FROM phone_handoff_attempts WHERE workspace_id=$1', [f.w])).rows).toHaveLength(0);
    } finally { await admission.session.query('COMMIT'); }
    await pending;
    expect((await database.session.query('SELECT id FROM phone_handoff_attempts WHERE workspace_id=$1', [f.w])).rows).toHaveLength(1);
  });

  it.each(['device', 'membership'] as const)('reads current %s status after waiting on its authority row', async kind => {
    const admission = await connection();
    const revocation = await connection();
    await revocation.session.query('BEGIN');
    // Acquire an exclusive row lock without publishing the restrictive status yet.
    const table = kind === 'device' ? 'devices' : 'workspace_memberships';
    const key = kind === 'device' ? 'id' : 'user_id';
    const id = kind === 'device' ? f.seeded.alpha.salesperson.deviceId : f.seeded.alpha.salesperson.userId;
    await revocation.session.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND ${key}=$2 FOR UPDATE`, [f.w, id]);
    const pending = withTransaction(admission.session, async () => await reserve(admission.session));
    try {
      await waitsOn(admission.pid, revocation.pid);
      await revoke(revocation.session, kind);
    } finally { await revocation.session.query('COMMIT'); }
    expect(await pending).toEqual({ ok: false, reason: 'phone_handoff_unavailable' });
    expect((await database.session.query('SELECT id FROM phone_handoff_attempts WHERE workspace_id=$1', [f.w])).rows).toHaveLength(0);
  });

  it.each([
    ['fifteen seconds', '2026-09-16T14:00:00Z', '2026-09-16T14:00:16Z'],
    ['window close', '2026-09-16T23:59:59.900Z', '2026-09-17T00:00:00Z'],
    ['registry expiry', '2026-09-16T14:00:00Z', '2026-09-16T14:00:00.100Z'],
  ])('does not renew the original %s expiry after an authority lock wait', async (boundary, at, finalAt) => {
    if (boundary === 'registry expiry') await f.publish({ downloadedAt: '2026-08-16T14:00:00.100Z', publishedAt: '2026-09-16T13:00:00Z' });
    const blocker = await connection();
    const admission = await connection();
    await blocker.session.query('BEGIN');
    await blocker.session.query('SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [f.w, f.seeded.alpha.salesperson.userId]);
    const command = f.request();
    const { at: fixtureAt, ...request } = command;
    expect(fixtureAt).toBe(f.policy.insideWindow);
    const clocked = decisionClocks(admission.session, at, finalAt);
    const pending = withTransaction(admission.session, async () => await reservePhoneHandoff(repositoryContext(f.context.scope, clocked), request));
    try { await waitsOn(admission.pid, blocker.pid); }
    finally { await blocker.session.query('ROLLBACK'); }
    expect(await pending).toEqual({ ok: false, reason: 'phone_handoff_unavailable' });
    expect((await database.session.query('SELECT id FROM phone_handoff_attempts WHERE workspace_id=$1', [f.w])).rows).toHaveLength(0);
  });

  it('keeps the original expiry when the final authority wait still fits its lifetime', async () => {
    const admission = await connection();
    const { at, ...request } = f.request();
    const clocked = decisionClocks(admission.session, at, '2026-09-16T14:00:01Z');
    const result = await withTransaction(admission.session, async () => await reservePhoneHandoff(repositoryContext(f.context.scope, clocked), request));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(await readPhoneHandoffResult(f.context, result.value.attemptId, false)).toMatchObject({
      actionable: true, reservedAt: '2026-09-16T14:00:00.000Z', expiresAt: '2026-09-16T14:00:15.000Z', validForMilliseconds: 15000,
    });
  });
});
