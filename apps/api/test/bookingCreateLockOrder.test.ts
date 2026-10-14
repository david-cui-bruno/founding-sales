import { expect, it } from 'vitest';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import { createBookingInterpretationAuthority } from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import { dispatch } from '../src/server.ts';
import { bookingCreateLockOrderFixture } from './support/bookingCreateLockOrderFixture.ts';

function barrier() {
  let resolve = () => {};
  const wait = new Promise<void>(done => { resolve = done; });
  return { wait, resolve };
}
it('normal interpretation read and owner-confirmed create serialize canonical sources before booking policy without a deadlock', async () => {
  const f = await bookingCreateLockOrderFixture();
  const reading = await f.fixture.database.appRuntimeSession();
  const sourceLocked = barrier(), resumeRead = barrier();
  let paused = false;
  const errors: string[] = [];
  const observedRead: SessionQueryable = {
    query: async <Row extends QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
      try {
        const result = await reading.query<Row>(text, values);
        if (!paused && text.includes('SELECT source_id FROM crm_mail_sources') && text.includes('FOR UPDATE')) {
          paused = true;
          sourceLocked.resolve();
          await resumeRead.wait;
        }
        return result;
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error) errors.push(String(error.code));
        throw error;
      }
    }
  };
  const observedCreate: SessionQueryable = {
    query: async <Row extends QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
      try { return await f.db.query<Row>(text, values); }
      catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error) errors.push(String(error.code));
        throw error;
      }
    }
  };
  const authority = createBookingInterpretationAuthority(f.runtime.policy);
  const interpret = (path: string, body: unknown, session: SessionQueryable) => dispatch({ method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${f.token}` } },
    { session, auth: { ...f.fixture.deps, db: session }, supportedClientVersions: f.fixture.deps.config.supportedClientVersions, sendingEnabled: false, bookingInterpretationAuthority: authority });
  let concurrent: Promise<unknown>[] = [];
  try {
    expect((await reading.query('SELECT current_user AS role')).rows[0]).toEqual({ role: 'app_runtime' });
    expect((await f.db.query('SELECT current_user AS role')).rows[0]).toEqual({ role: 'app_runtime' });
    const requested = await interpret('/crm/booking/interpretation/request', f.command({ source: f.payload.agreement, priorSources: [f.payload.offeredContext] }), reading);
    expect(requested.body).toMatchObject({ result: { state: 'pending' } });
    const requestId = (requested.body as { result: { requestId: string } }).result.requestId;
    const readPid = (await reading.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const createPid = (await f.db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const read = interpret('/crm/booking/interpretation/read', { requestId }, observedRead);
    concurrent = [read];
    await sourceLocked.wait;
    const create = f.request('POST', '/meetings/booking-create', f.command(f.payload), observedCreate);
    concurrent.push(create);
    // Attach settlement before releasing the barrier so an actual PG deadlock is
    // retained as evidence, not an unhandled rejection or a synthetic lock proxy.
    const settled = Promise.allSettled([read, create]);
    let sourceWaitObserved = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const waits = await f.fixture.db.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND $2::int=ANY(pg_blocking_pids(pid))', [createPid, readPid]);
      if (waits.rows.length === 1) { sourceWaitObserved = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(sourceWaitObserved, 'public create must actually wait for the read-held canonical source closure').toBe(true);
    resumeRead.resolve();
    const results = await settled;
    expect(errors, 'ordinary read/create overlap must not produce PostgreSQL 40P01').not.toContain('40P01');
    expect(results.map(result => result.status === 'fulfilled' ? result.value.status : String(result.reason))).toEqual([200, 200]);
    expect((await f.fixture.db.query('SELECT state FROM booking_create_submissions WHERE workspace_id=$1', [f.fixture.alpha.workspaceId])).rows).toEqual([{ state: 'pending' }]);
  } finally {
    resumeRead.resolve();
    await Promise.allSettled(concurrent);
    await f.fixture.stop();
  }
});
