import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { workspaceScope } from '@fss/domain/db';
import { HandlerRegistry, runTwiceUnderStolenLease } from '@fss/domain/jobs';
import { RETENTION_LEDGER_KINDS, retentionBatchJobKey, retentionPeriodOf } from '@fss/domain/retention';
import { runClaimedJob } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import { retentionBatchJobHandler, retentionSource } from '../src/handlers/retention.ts';

/**
 * The `retention.batch` job (Appendix C, specification 10.3, 13.1, Appendix G 1
 * and 2).
 *
 * Three things are proved here and nowhere else: the registry accepts it under
 * Appendix C's protection and no other; the pass materializes one job per workspace,
 * kind and UTC day however many times it runs; and it produces one effect under a
 * real stolen lease, which `docs/greenfield/jobs.md` makes mandatory for every lane
 * that registers a handler.
 *
 * The stolen-lease probe is the one that matters most for this kind, because the
 * effect is a *delete*. A handler that ran twice would sweep twice, and the second
 * sweep is the one that reaches rows the first left alone if anything about the
 * boundary moved. `retention_runs_one_per_period` is what stops it, and the probe
 * proves that rather than asserting it.
 *
 * No real business name appears; `example.test` is reserved by RFC 6761.
 */
describe('the retention batch as a job', () => {
  let database: TestDatabase;
  let workspaceId: string;
  let mailboxId = '';
  let now = '';

  beforeAll(async () => {
    database = await createTestDatabase();
    const workspace = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = workspace.rows[0]?.id ?? '';
    const user = await database.session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-retention', 'retention@example.test', 'Retention') RETURNING id",
    );
    const userId = user.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [workspaceId, userId],
    );
    const mailbox = await database.session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address)
       VALUES ($1, $2, 'sales.alpha@example.test') RETURNING id`,
      [workspaceId, userId],
    );
    mailboxId = mailbox.rows[0]?.id ?? '';

    const clock = await database.session.query<{ now: Date }>('SELECT now() AS now');
    now = (clock.rows[0]?.now ?? new Date()).toISOString();
  });

  afterAll(async () => {
    await database.drop();
  });

  /** Two unmatched messages, far enough past the thirty-day boundary to be swept. */
  const seedExpiredMetadata = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      await database.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id,
                                    direction, internal_date, matched, recorded_at)
         VALUES ($1, $2, $3, $3, 'incoming', now() - INTERVAL '200 days', false, now() - INTERVAL '200 days')`,
        [workspaceId, mailboxId, `expired_${String(index)}_${String(Date.now())}`],
      );
    }
  };

  it('registers under the protection Appendix C names, and refuses any other', () => {
    const registry = new HandlerRegistry().register(retentionBatchJobHandler());
    expect(registry.kinds()).toContain('retention.batch');
    expect(registry.get('retention.batch')?.protection).toBe('business_uniqueness');
    expect(() =>
      new HandlerRegistry().register({ ...retentionBatchJobHandler(), protection: 'fencing_token' }),
    ).toThrow(/business_uniqueness/);
  });

  it('materializes one job per workspace, kind and UTC day, however many passes run', async () => {
    for (const offsetMinutes of [0, 1, 240]) {
      const report = await runSchedulerPass(database.session, {
        sources: [retentionSource()],
        // Same UTC day, three different minutes.
        now: new Date(Date.parse(`${retentionPeriodOf(now)}T00:30:00.000Z`) + offsetMinutes * 60_000).toISOString(),
        instanceKey: `pass-${String(offsetMinutes)}`,
      });
      expect(report.outcome).toBe('ran');
    }
    const { rows } = await database.session.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM jobs WHERE workspace_id = $1 AND kind = 'retention.batch' ORDER BY idempotency_key",
      [workspaceId],
    );
    expect(rows).toHaveLength(RETENTION_LEDGER_KINDS.length);
    expect(rows.map(row => row.idempotency_key)).toEqual(
      [...RETENTION_LEDGER_KINDS].map(kind => retentionBatchJobKey(kind, retentionPeriodOf(now))).sort(),
    );
  });

  it('sweeps once when a stolen lease makes it run twice', async () => {
    await database.session.query("DELETE FROM jobs WHERE workspace_id = $1 AND kind = 'retention.batch'", [
      workspaceId,
    ]);
    await seedExpiredMetadata(2);

    const before = await countMessages();
    expect(before).toBe(2);

    const registry = new HandlerRegistry().register(retentionBatchJobHandler());
    const period = retentionPeriodOf(now);
    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry,
      run: runClaimedJob,
      workspaceId,
      kind: 'retention.batch',
      idempotencyKey: retentionBatchJobKey('unmatched_gmail_metadata', period),
      payload: { dataKind: 'unmatched_gmail_metadata', period },
      countEffects: countMessages,
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    // Both expired rows go, and the worker that wakes up late takes nothing further.
    expect(report.effectsBefore - report.effectsAfter).toBe(2);
    expect(report.freshFencingToken).not.toBe(report.staleFencingToken);

    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM retention_runs WHERE workspace_id = $1 AND data_kind = 'unmatched_gmail_metadata'",
      [workspaceId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('refuses a payload that names no kind, or a kind that is not one', async () => {
    const handler = retentionBatchJobHandler();
    const job = (payload: Record<string, unknown>) => ({
      session: database.session,
      scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' as const }),
      job: {
        id: '00000000-0000-4000-8000-000000000000',
        workspaceId,
        kind: 'retention.batch',
        idempotencyKey: 'retention:x:2026-09-20',
        payload,
        attempt: 1,
        maxAttempts: 6,
        fencingToken: '1',
        leaseOwner: 'test',
        leaseExpiresAt: new Date().toISOString(),
      },
    });
    await expect(handler.handle(job({}))).rejects.toThrow(/retention kinds/);
    await expect(handler.handle(job({ dataKind: 'everything', period: '2026-09-20' }))).rejects.toThrow(
      /retention kinds/,
    );
    await expect(handler.handle(job({ dataKind: 'raw_mime' }))).rejects.toThrow(/period/);
  });

  async function countMessages(): Promise<number> {
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM mail_messages WHERE workspace_id = $1',
      [workspaceId],
    );
    return Number(rows[0]?.count);
  }
});
