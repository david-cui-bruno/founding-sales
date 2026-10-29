import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTransaction, type QueryResultRowLike, type SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { consumeCallSession, sweepCallSessionReservations, workspacesOwingCallSessionSweep } from '../../calls/sessions.ts';
import {
  AUDIO_TEST_PG_CALLER, audioTestPgBusinessSnapshot, audioTestPgInsertHistory, audioTestPgSid,
  audioTestPgWaitForBlock, audioTestPgWorld, type AudioTestPgWorld,
} from './audioTestPgFixture.ts';

type Observed<T> = { readonly value: T } | { readonly errorCode: string };
const observe = async <T>(operation: Promise<T>): Promise<Observed<T>> => {
  try { return { value: await operation }; }
  catch (error) { return { errorCode: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'non_pg_error' }; }
};
async function within<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}

let world: AudioTestPgWorld;
beforeAll(async () => { world = await audioTestPgWorld(); });
afterAll(async () => {
  if (world) { await world.database.drop(); console.info('AUDIO_TEST_SWEEP_DATABASE_DROPPED', world.database.name); }
});

it('broad expiry erasure skips a consuming request without a monthly-lock cycle and leaves it owed for the next sweep', async () => {
  const consumer = world.runtime, sweeper = world.blocker, observer = world.database.session, workspaceId = world.seed.beta.workspaceId;
  for (const db of [consumer, sweeper]) {
    expect((await db.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user).toBe('app_runtime');
    await db.query("SET statement_timeout='10s'");
    await db.query("SET lock_timeout='0'");
  }
  const consumerPid = (await consumer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const sweeperPid = (await sweeper.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const overdue = await audioTestPgInsertHistory(world, { daysAgo: 1 });
  const live = await audioTestPgInsertHistory(world, { lifetimeMilliseconds: 5000 });
  let releaseErasure!: () => void, reachedErasure!: () => void;
  const release = new Promise<void>(resolve => { releaseErasure = resolve; });
  const reached = new Promise<void>(resolve => { reachedErasure = resolve; });
  let selectedReservations: readonly string[] = [];
  // A barrier only: every statement and result still uses the real app_runtime connection.
  // Pausing before erasure leaves the sweep's actual settlement/monthly lock held.
  const controlledSweep: SessionQueryable = { async query<Row extends QueryResultRowLike>(sql: string, values?: readonly unknown[]) {
    if (sql.includes('UPDATE browser_audio_test_requests') && values?.[1] === null) {
      reachedErasure(); await release;
    }
    const result = await sweeper.query<Row>(sql, values);
    if (sql.includes('SELECT s.reservation_id')) selectedReservations = result.rows.map(row => String(row['reservation_id']));
    return result;
  } };
  const sweepContext = repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), controlledSweep);
  let sweep: Promise<Observed<Awaited<ReturnType<typeof sweepCallSessionReservations>>>> | undefined;
  let consume: Promise<Observed<Awaited<ReturnType<typeof consumeCallSession>>>> | undefined;
  let initiallyLive = false;
  const started = Date.now();
  try {
    sweep = observe(withTransaction(sweeper, async () => {
      initiallyLive = (await sweeper.query<{ live: boolean }>('SELECT now()<$1::timestamptz AS live', [live.expiresAt])).rows[0]?.live === true;
      return await sweepCallSessionReservations(sweepContext);
    }));
    await within(Promise.race([reached, sweep.then(result => { throw new Error(`sweep ended before erasure: ${JSON.stringify(result)}`); })]), 2500, 'sweep did not reach its actual erasure seam');
    consume = observe(withTransaction(consumer, () => consumeCallSession(consumer, {
      workspaceId, sessionId: live.sessionId, callSid: audioTestPgSid(), identity: `client:${world.seed.beta.admin.userId}`,
      configuredCallerIdE164: AUDIO_TEST_PG_CALLER,
    })));
    await audioTestPgWaitForBlock(observer, consumerPid, sweeperPid);
    const blocked = (await observer.query<{ query: string; wait_event_type: string }>(
      'SELECT query,wait_event_type FROM pg_stat_activity WHERE pid=$1', [consumerPid])).rows[0]!;
    // Only the consumer has touched this live request; the sweep excluded its session.
    // A real NOWAIT refusal proves the request lock independently of the forwarding barrier.
    const requestProbe = await observe(withTransaction(observer, () => observer.query('SELECT id FROM browser_audio_test_requests WHERE id=$1 FOR UPDATE NOWAIT',
      [live.requestId])));
    let expired = false;
    for (let n = 0; n < 700; n += 1) {
      expired = (await observer.query<{ expired: boolean }>('SELECT expires_at<=clock_timestamp() AS expired FROM browser_audio_test_requests WHERE id=$1', [live.requestId])).rows[0]?.expired === true;
      if (expired) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    releaseErasure();
    const [sweepResult, consumeResult] = await within(Promise.all([sweep, consume]), 6500, 'sweep/consume failed to drain within their statement limits');
    // Both withTransaction owners have committed/rolled back before any race assertions.
    for (const db of [consumer, sweeper]) await db.query('ROLLBACK');
    console.info('AUDIO_TEST_SWEEP_LOCK_OBSERVATION', JSON.stringify({ sweeperPid, consumerPid,
      monthlyWaitObserved: blocked.wait_event_type === 'Lock' && blocked.query.includes('pg_advisory_xact_lock'),
      requestShareObserved: 'errorCode' in requestProbe && requestProbe.errorCode === '55P03', originalDeadlineCrossed: expired,
      drainedMilliseconds: Date.now() - started, sweep: sweepResult, consume: consumeResult }));
    expect(initiallyLive).toBe(true);
    expect(selectedReservations).toEqual([overdue.reservationId]);
    expect(blocked.wait_event_type).toBe('Lock');
    expect(blocked.query).toContain('pg_advisory_xact_lock');
    expect(requestProbe).toEqual({ errorCode: '55P03' });
    expect(expired).toBe(true);
    expect(sweepResult).toEqual({ value: { released: 1, estimated: 0 } });
    expect(consumeResult).toEqual({ value: { ok: false, reason: 'ticket_expired' } });
    // The first sweep must skip a locked request instead of waiting while holding monthly cash.
    const first = (await observer.query<{ id: string; e164_present: boolean; consumed_at: Date | null; twilio_call_sid: string | null; state: string }>(
      `SELECT s.id,r.e164 IS NOT NULL AS e164_present,s.consumed_at,s.twilio_call_sid,p.state
        FROM call_sessions s JOIN browser_audio_test_requests r ON r.workspace_id=s.workspace_id AND r.id=s.audio_test_request_id
        JOIN provider_reservations p ON p.workspace_id=s.workspace_id AND p.id=s.reservation_id
       WHERE s.id=ANY($1::uuid[]) ORDER BY s.id`, [[overdue.sessionId, live.sessionId]])).rows;
    expect(first.find(row => row.id === overdue.sessionId)).toMatchObject({ e164_present: false, state: 'released', consumed_at: null, twilio_call_sid: null });
    expect(first.find(row => row.id === live.sessionId)).toMatchObject({ e164_present: true, state: 'reserved', consumed_at: null, twilio_call_sid: null });
    expect(await workspacesOwingCallSessionSweep(observer)).toContain(workspaceId);
    const later = await withTransaction(consumer, () => sweepCallSessionReservations(world.admin('beta')));
    expect(later).toEqual({ released: 1, estimated: 0 });
    expect((await observer.query(`SELECT s.id,r.e164,s.consumed_at,s.twilio_call_sid,p.state,p.settled_cents
      FROM call_sessions s JOIN browser_audio_test_requests r ON r.workspace_id=s.workspace_id AND r.id=s.audio_test_request_id
      JOIN provider_reservations p ON p.workspace_id=s.workspace_id AND p.id=s.reservation_id
      WHERE s.id=ANY($1::uuid[])`, [[overdue.sessionId, live.sessionId]])).rows).toEqual(expect.arrayContaining([
      { id: overdue.sessionId, e164: null, consumed_at: null, twilio_call_sid: null, state: 'released', settled_cents: 0 },
      { id: live.sessionId, e164: null, consumed_at: null, twilio_call_sid: null, state: 'released', settled_cents: 0 },
    ]));
    expect(await workspacesOwingCallSessionSweep(observer)).not.toContain(workspaceId);
    expect(await audioTestPgBusinessSnapshot(observer, world.seed.alpha.workspaceId, world.legacyIds)).toEqual(world.before);
    expect((await observer.query("SELECT count(*)::int AS n FROM jobs WHERE workspace_id=$1 AND kind LIKE 'call.%'", [workspaceId])).rows).toEqual([{ n: 0 }]);
  } finally {
    releaseErasure();
    await Promise.allSettled([...(sweep ? [sweep] : []), ...(consume ? [consume] : [])]);
    for (const db of [consumer, sweeper]) await db.query('ROLLBACK');
  }
});
