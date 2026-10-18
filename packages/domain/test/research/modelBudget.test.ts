import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, asSession, CLUSTER_URL_ENVIRONMENT_VARIABLE, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { localDate } from '../../src/rules/localClock.ts';
import { reserveAttempt, markCalling, settleAttempt, correctSettledCents, type ReserveInput } from '../../research/reservations.ts';
import { readCreditModelSpend, ModelBudgetRefusal } from '../../research/modelBudget.ts';
import { readSpend, readResearchSpend, recordProviderCall } from '../../research/ledger.ts';

let database: TestDatabase;
let seeded: TwoWorkspaces;
const clients: pg.Client[] = [];
const ZONE = 'America/New_York';
const AT = new Date().toISOString();
const contextOn = (session: SessionQueryable) => repositoryContext(
  workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session,
);
const input = (overrides: Partial<ReserveInput> = {}): ReserveInput => ({
  providerKey: 'aws_bedrock.extraction', subjectKind: 'research_run', subjectId: randomUUID(),
  attempt: 1, at: AT, businessTimeZone: ZONE, cents: 10, modelName: 'claude-haiku-4-5',
  maxInputTokens: 100, maxOutputTokens: 100, ...overrides,
});
const tx = <T>(work: (context: ReturnType<typeof contextOn>) => Promise<T>) =>
  withTransaction(database.session, () => work(contextOn(database.session)));
const spend = (at = AT) => readCreditModelSpend(contextOn(database.session), { at, businessTimeZone: ZONE });
async function cost(cents: number, providerKey = 'aws_bedrock.classifier', at = AT): Promise<void> {
  await tx(context => recordProviderCall(context, { providerKey, at, businessTimeZone: ZONE, costCents: cents }));
}
async function connection(): Promise<SessionQueryable> {
  const url = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  url.pathname = `/${database.name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  clients.push(client);
  return asSession(client as unknown as Parameters<typeof asSession>[0]);
}
beforeAll(async () => { database = await createTestDatabase(); seeded = await seedTwoWorkspaces(database.session); });
afterAll(async () => { for (const client of clients) await client.end(); await database.drop(); });
beforeEach(async () => {
  await database.session.query('DELETE FROM provider_reservations');
  await database.session.query('DELETE FROM provider_ledger');
});

describe('atomic workspace credit-funded MODEL cap, real PostgreSQL transactions', () => {
  it('serializes cross-lane claims at 5000 cents on independent connections', async () => {
    await cost(4990);
    const a = await connection(), b = await connection();
    const outcomes = await Promise.allSettled([
      withTransaction(a, () => reserveAttempt(contextOn(a), input({ subjectKind: 'reply_classification' }))),
      withTransaction(b, () => reserveAttempt(contextOn(b), input({ subjectKind: 'crm_extraction', providerKey: 'aws_bedrock.crm_extraction' }))),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const refusal = outcomes.find(outcome => outcome.status === 'rejected');
    expect(refusal).toMatchObject({ status: 'rejected', reason: { code: 'credit_model_daily_ceiling', retryable: false } });
    expect((await spend()).todayCents).toBe(5000);
  });

  it('concurrent duplicate identity reuses exactly once, including at the cap and after settlement', async () => {
    await cost(4990);
    const a = await connection(), b = await connection(), request = input();
    const rows = await Promise.all([
      withTransaction(a, () => reserveAttempt(contextOn(a), request)),
      withTransaction(b, () => reserveAttempt(contextOn(b), request)),
    ]);
    expect(rows[0]?.id).toBe(rows[1]?.id);
    const row = rows[0]; if (!row) throw new Error('missing reservation');
    expect(await tx(context => markCalling(context, row.id))).toBe(true);
    expect(await tx(context => markCalling(context, row.id))).toBe(false);
    await tx(context => settleAttempt(context, { reservationId: row.id, at: AT, outcome: { kind: 'settled', cents: 5 } }));
    const replay = await tx(context => reserveAttempt(context, request));
    expect(replay).toMatchObject({ id: row.id, state: 'settled', settledCents: 5 });
    expect(await tx(context => markCalling(context, replay.id))).toBe(false);
    expect((await spend()).todayCents).toBe(4995);
    await expect(tx(context => reserveAttempt(context, { ...request, cents: 11 }))).rejects.toMatchObject({ code: 'model_reservation_mismatch' });
  });

  it('open, calling, estimated, settled and released are counted once across correction/retry', async () => {
    const row = await tx(context => reserveAttempt(context, input()));
    expect((await spend()).todayCents).toBe(10);
    await tx(context => markCalling(context, row.id));
    await tx(context => settleAttempt(context, { reservationId: row.id, at: AT, outcome: { kind: 'released' } }));
    expect((await spend()).todayCents).toBe(10);
    await tx(context => settleAttempt(context, { reservationId: row.id, at: AT, outcome: { kind: 'estimated' } }));
    expect((await spend()).todayCents).toBe(10);
    await tx(context => settleAttempt(context, { reservationId: row.id, at: AT, outcome: { kind: 'estimated' } }));
    await tx(context => correctSettledCents(context, { reservationId: row.id, cents: 4 }));
    await tx(context => correctSettledCents(context, { reservationId: row.id, cents: 4 }));
    expect((await spend()).todayCents).toBe(4);
    const retry = await tx(context => reserveAttempt(context, input({ attempt: 2 })));
    expect((await spend()).todayCents).toBe(14);
    await tx(context => settleAttempt(context, { reservationId: retry.id, at: AT, outcome: { kind: 'released' } }));
    expect((await spend()).todayCents).toBe(4);
  });

  it('rechecks the complete open sum before calling, without adding its own cents twice', async () => {
    const row = await tx(context => reserveAttempt(context, input()));
    await cost(4991); // Later settlement/correction can put already reserved work over cap.
    await expect(tx(context => markCalling(context, row.id))).rejects.toBeInstanceOf(ModelBudgetRefusal);
    expect((await database.session.query('SELECT state FROM provider_reservations WHERE id=$1', [row.id])).rows).toEqual([{ state: 'reserved' }]);
    await cost(0);
    expect((await spend()).todayCents).toBe(5001);
  });

  it('stale previous-day/month reservations are never moved, replayed or released from calling', async () => {
    const request = input({ at: '2026-01-31T23:00:00Z' });
    const row = await tx(context => reserveAttempt(context, request));
    await expect(tx(context => markCalling(context, row.id))).rejects.toMatchObject({ code: 'model_reservation_stale', retryable: false });
    const reused = await tx(context => reserveAttempt(context, { ...request, at: AT }));
    expect(reused).toMatchObject({ id: row.id, businessDate: '2026-01-31', state: 'reserved' });
    expect((await spend()).todayCents).toBe(0);
    await tx(context => settleAttempt(context, { reservationId: row.id, at: AT, outcome: { kind: 'released' } }));
    const fresh = await tx(context => reserveAttempt(context, { ...request, at: AT, attempt: 2 }));
    expect(fresh.businessDate).toBe(localDate(AT, ZONE));
    expect(await tx(context => markCalling(context, fresh.id))).toBe(true);
    await tx(context => settleAttempt(context, { reservationId: fresh.id, at: AT, outcome: { kind: 'released' } }));
    expect(await tx(context => markCalling(context, fresh.id))).toBe(false);
    expect((await spend()).todayCents).toBe(10);
  });

  it('uses immutable business dates for daily/monthly sums, not UTC or settlement date', async () => {
    const row = await tx(context => reserveAttempt(context, input({ at: '2026-10-01T03:59:00Z' })));
    await tx(context => settleAttempt(context, { reservationId: row.id, at: '2026-10-01T04:01:00Z', outcome: { kind: 'estimated' } }));
    expect(await spend('2026-10-01T03:59:00Z')).toEqual({ todayCents: 10, monthToDateCents: 10 });
    expect(await spend('2026-10-01T04:01:00Z')).toEqual({ todayCents: 0, monthToDateCents: 0 });
    await tx(context => correctSettledCents(context, { reservationId: row.id, cents: 6 }));
    expect(await spend('2026-10-01T03:59:00Z')).toEqual({ todayCents: 6, monthToDateCents: 6 });
  });

  it('excludes independent Transcribe and preserves cash classification and sums', async () => {
    await cost(9000, 'aws_transcribe.standard');
    await cost(35, 'anthropic_extraction');
    const row = await tx(context => reserveAttempt(context, input()));
    expect(await tx(context => markCalling(context, row.id))).toBe(true);
    expect((await spend()).todayCents).toBe(10);
    expect(await readSpend(contextOn(database.session), { at: AT, businessTimeZone: ZONE })).toEqual({ todayCents: 35, monthToDateCents: 35 });
    expect((await readResearchSpend(contextOn(database.session), { at: AT, businessTimeZone: ZONE })).todayCents).toBe(9045);
  });

  it('settlement and correction take the shared lock before changing reservation rows', async () => {
    const row = await tx(context => reserveAttempt(context, input()));
    const other = await connection();
    await database.session.query('BEGIN');
    await database.session.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${seeded.alpha.workspaceId}:monthly_cash_ceiling`]);
    await other.query("SET lock_timeout='100ms'");
    await expect(withTransaction(other, () => settleAttempt(contextOn(other), { reservationId: row.id, at: AT, outcome: { kind: 'estimated' } }))).rejects.toMatchObject({ code: '55P03' });
    await database.session.query('COMMIT');
    await tx(context => settleAttempt(context, { reservationId: row.id, at: AT, outcome: { kind: 'estimated' } }));
    await database.session.query('BEGIN');
    await database.session.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${seeded.alpha.workspaceId}:monthly_cash_ceiling`]);
    await expect(withTransaction(other, () => correctSettledCents(contextOn(other), { reservationId: row.id, cents: 5 }))).rejects.toMatchObject({ code: '55P03' });
    await database.session.query('COMMIT');
    expect((await spend()).todayCents).toBe(10);
  });
});
