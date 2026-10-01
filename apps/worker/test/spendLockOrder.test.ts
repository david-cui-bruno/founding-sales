import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consumeCallSession,
  createCallSession,
  recordCallRecording,
  recordCallStatus,
  sweepCallSessionReservations,
} from '@fss/domain/calls/sessions.ts';
import { beginCallTranscription, ensureTranscriptionCalling, sweepTranscriptionReservations } from '@fss/domain/calls/transcription.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession, createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { withTransaction, type QueryResultRowLike, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { updateSetting } from '@fss/domain/settings/store.ts';
import { seedCrm, type SeededCrm } from '@fss/domain/test/db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { seedPolicy, type SeededPolicy } from '@fss/domain/test/db/support/policyFixtures.ts';
import { DEEPGRAM_PROVIDER_KEY } from '../src/transcription/deepgramClient.ts';

/**
 * Slice P1, fix round 2, finding 4: one lock order including the ledger rows.
 *
 * The review's three transactions, in one workspace, on one business date:
 *
 *   * S — the telephony sweep: estimates an abandoned call (the Twilio ledger row), then an
 *     abandoned transcription (the Deepgram ledger row);
 *   * R — transcription recovery: estimates an earlier claim's attempt (the Deepgram row),
 *     then clears a retry under the monthly lock;
 *   * C — a terminal callback: the monthly lock, then the call's settlement (the Twilio row).
 *
 * Driven on three real connections into the interleaving that closed the cycle — S holds
 * the Twilio row, C holds the month and waits for it, R holds the Deepgram row and waits
 * for the month, S asks for the Deepgram row. With every ledger write taking the monthly
 * lock first, S holds the month before its first ledger row, so C and R wait for S and all
 * three commit. Without it PostgreSQL reports a deadlock and aborts one of them.
 */
describe('the sweep, a transcription recovery and a callback, at once (P1 fix round 2)', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  const clients: pg.Client[] = [];
  let counter = 0;

  const contextOn = (db: SessionQueryable): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), db);
  const admin = (): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), database.session);
  const salesperson = (): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      database.session,
    );

  async function setting(settingKey: 'call_transcription' | 'telephony_budget' | 'monthly_cash_ceiling_cents', value: unknown): Promise<void> {
    const saved = await withTransaction(database.session, async () => await updateSetting(admin(), { settingKey, value }));
    if (!saved.ok) throw new Error(saved.reason);
  }

  async function connection(): Promise<SessionQueryable> {
    const url = new URL((process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '').trim());
    url.pathname = `/${database.name}`;
    const client = new pg.Client({ connectionString: url.toString() });
    client.on('error', () => undefined);
    await client.connect();
    clients.push(client);
    return asSession(client as unknown as Parameters<typeof asSession>[0]);
  }

  /** A placed call: its session id and SID. `ended` sends the final callback and the recording. */
  async function placed(options: { readonly ended: boolean; readonly consumedLongAgo: boolean }): Promise<{ sessionId: string; sid: string }> {
    counter += 1;
    const created = await withTransaction(database.session, async () =>
      await createCallSession(salesperson(), {
        firmId: crm.alpha.firmId,
        routeId: policy.alpha.phoneRouteId,
        routeVersion: policy.alpha.phoneRouteVersion,
        callingIdentityId: policy.alpha.callingIdentityId,
        deviceId: seeded.alpha.salesperson.deviceId,
        commandId: `lock-order-${String(counter)}`,
        configuredCallerIdE164: '+14015550100',
        at: policy.insideWindow,
      }),
    );
    if (!created.ok) throw new Error(created.reason);
    const sessionId = created.value.sessionId;
    const sid = `CA${randomBytes(16).toString('hex')}`;
    const consumed = await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, {
        workspaceId: seeded.alpha.workspaceId,
        sessionId,
        callSid: sid,
        identity: `client:${seeded.alpha.salesperson.userId}`,
        at: policy.insideWindow,
      }),
    );
    if (!consumed.ok) throw new Error(consumed.reason);
    await database.session.query(
      `UPDATE call_sessions SET consumed_at = CASE WHEN $2 THEN '2026-08-03T14:00:00Z'::timestamptz ELSE now() END,
              expires_at = GREATEST(expires_at, '2026-08-03T14:00:00Z') WHERE id = $1`,
      [sessionId, options.consumedLongAgo],
    );
    if (options.ended) {
      await withTransaction(database.session, async () => {
        await recordCallStatus(database.session, { callSid: sid, providerStatus: 'in-progress' });
        await recordCallStatus(database.session, { callSid: sid, providerStatus: 'completed', durationSeconds: 90 });
        await recordCallRecording(database.session, {
          callSid: sid,
          recordingSid: `RE${randomBytes(16).toString('hex')}`,
          recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${randomBytes(16).toString('hex')}`,
          durationSeconds: 90,
        });
      });
    }
    return { sessionId, sid };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    policy = await seedPolicy(database.session, seeded, crm);
    await setting('telephony_budget', { dailyCeilingCents: 10_000, maxMinutesPerCall: 30, unitPriceMicros: 14_000 });
    await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    await setting('monthly_cash_ceiling_cents', { cents: 5000 });
  });

  afterAll(async () => {
    for (const client of clients) await client.end().catch(() => undefined);
    await database.drop();
  });

  it('all three commit; none is chosen as a deadlock victim', async () => {
    const at = new Date().toISOString();
    const common = (sessionId: string) => ({ sessionId, at, keyConfigured: true, providerKey: DEEPGRAM_PROVIDER_KEY });
    // S's two subjects: a placed call whose final callback never came, and an abandoned
    // transcription attempt half an hour old.
    await placed({ ended: false, consumedLongAgo: true });
    const abandoned = await placed({ ended: true, consumedLongAgo: true });
    await withTransaction(database.session, async () => await beginCallTranscription(contextOn(database.session), common(abandoned.sessionId)));
    await withTransaction(database.session, async () => await ensureTranscriptionCalling(contextOn(database.session), common(abandoned.sessionId)));
    await database.session.query(
      "UPDATE provider_reservations SET created_at = now() - interval '31 minutes' WHERE subject_kind = 'call_transcription' AND subject_id = $1",
      [abandoned.sessionId],
    );
    // R's subject: a transcription another claim marked `calling` a moment ago.
    const recovering = await placed({ ended: true, consumedLongAgo: true });
    await withTransaction(database.session, async () => await beginCallTranscription(contextOn(database.session), common(recovering.sessionId)));
    await withTransaction(database.session, async () => await ensureTranscriptionCalling(contextOn(database.session), common(recovering.sessionId)));
    // C's subject: a call in progress, placed just now, whose final callback carries a price.
    const live = await placed({ ended: false, consumedLongAgo: false });

    const signals = new Map<string, () => void>();
    const fired = new Map<string, Promise<void>>();
    for (const name of ['sTwilio', 'cMonthly', 'rDeepgram']) {
      fired.set(name, new Promise<void>(resolve => signals.set(name, resolve)));
    }
    const signal = (name: string): void => signals.get(name)?.();
    const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms));
    const either = async (name: string, ms: number): Promise<void> => await Promise.race([fired.get(name), sleep(ms)]);
    const isLedgerWrite = (text: string): boolean => text.includes('INSERT INTO provider_ledger');
    const isMonthly = (values?: readonly unknown[]): boolean =>
      typeof values?.[0] === 'string' && values[0].endsWith(':monthly_cash_ceiling');

    const sRaw = await connection();
    const cRaw = await connection();
    const rRaw = await connection();
    let sPaused = false;
    const sSession: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        const result = await sRaw.query<Row>(text, values);
        if (!sPaused && isLedgerWrite(text)) {
          // S holds its first ledger row (Twilio). Wait for R to take the Deepgram row.
          sPaused = true;
          signal('sTwilio');
          await either('rDeepgram', 3000);
        }
        return result;
      },
    };
    const cSession: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        const result = await cRaw.query<Row>(text, values);
        if (isMonthly(values)) signal('cMonthly');
        return result;
      },
    };
    const rSession: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        const result = await rRaw.query<Row>(text, values);
        if (isLedgerWrite(text)) signal('rDeepgram');
        return result;
      },
    };

    const sweep = withTransaction(sSession, async () => {
      await sweepCallSessionReservations(contextOn(sSession));
      await sweepTranscriptionReservations(contextOn(sSession));
    });
    await either('sTwilio', 5000);
    const callback = withTransaction(cSession, async () =>
      await recordCallStatus(cSession, { callSid: live.sid, providerStatus: 'completed', durationSeconds: 61, priceDollars: -0.028 }),
    );
    await either('cMonthly', 1500);
    const recovery = withTransaction(rSession, async () => await ensureTranscriptionCalling(contextOn(rSession), common(recovering.sessionId)));

    const settled = await Promise.allSettled([sweep, callback, recovery]);
    const failures = settled.flatMap(outcome =>
      outcome.status === 'rejected' ? [String((outcome.reason as { code?: string; message?: string }).code ?? (outcome.reason as Error).message)] : [],
    );
    expect(failures).toEqual([]);
    // And each did its work: the abandoned call and transcription estimated, the live call
    // settled at its price, the recovered transcription on a fresh attempt.
    const { rows } = await database.session.query<{ subject_id: string; attempt: number; state: string }>(
      `SELECT subject_id, attempt, state FROM provider_reservations
        WHERE subject_kind = 'call_transcription' AND subject_id = ANY($1::uuid[]) ORDER BY subject_id, attempt`,
      [[abandoned.sessionId, recovering.sessionId]],
    );
    expect(rows.filter(row => row.subject_id === abandoned.sessionId).map(row => row.state)).toEqual(['estimated']);
    expect(rows.filter(row => row.subject_id === recovering.sessionId).map(row => row.state)).toEqual(['estimated', 'calling']);
    expect(settled[1]).toMatchObject({ status: 'fulfilled', value: { settlement: 'settled' } });
  }, 30_000);
});
