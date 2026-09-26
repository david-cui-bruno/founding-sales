import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { METRIC_OWNERS } from '../../jobs/metrics.ts';
import { COVERAGE_FRESHNESS_SECONDS, coverageRefusal, readMailboxCoverage } from '../../mail/coverage.ts';
import { MAIL_METRIC_NAMES, collectMailMetrics, mailboxCoverageAgeSeconds } from '../../mail/metrics.ts';
import { seedTwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * `MailboxCoverageAgeSeconds` says what the send gate will say.
 *
 * The send path holds every automated email for an owner whose coverage watermark is
 * older than `COVERAGE_FRESHNESS_SECONDS`, so the worker publishes the stalest connected,
 * `ready` mailbox's watermark age, and the warning `mailbox_coverage_stale` alarms
 * above the same fifteen minutes.
 *
 * ## The vacuous-pass trap, named
 *
 * A gauge that read a plausible number could still disagree with the gate at exactly
 * the cases that matter: no watermark, a watermark from the future, a mailbox mid
 * baseline. So every case below is judged twice, by the gauge and by the gate's own
 * `readMailboxCoverage` + `coverageRefusal` on the same row, and the two must agree
 * about which side of the window it is on. The cases straddle each boundary: 14 and 16
 * minutes, one minute and ten minutes in the future.
 */

describe('MailboxCoverageAgeSeconds agrees with the send gate', () => {
  let database: TestDatabase;
  let workspaceId: string;
  let owner: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const seeded = await seedTwoWorkspaces(database.session);
    workspaceId = seeded.alpha.workspaceId;
    owner = seeded.alpha.salesperson.userId;
  });

  afterAll(async () => {
    await database.drop();
  });

  /** One mailbox, replaced each time: the gauge is a maximum, so one at a time is exact. */
  const only = async (
    syncState: 'ready' | 'baseline_pending' | 'recovering',
    watermarkOffsetSeconds: number | null,
    status: 'connected' | 'disconnected' = 'connected',
  ): Promise<string> => {
    await database.session.query('DELETE FROM mailboxes WHERE workspace_id = $1', [workspaceId]);
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, status, disconnected_at, disconnect_reason,
                              sync_state, history_id, history_id_updated_at, coverage_watermark_at,
                              baseline_from_at, baseline_completed_at)
       VALUES ($1, $2, 'coverage@example.test', $3,
               CASE WHEN $3 = 'connected' THEN NULL ELSE now() END,
               CASE WHEN $3 = 'connected' THEN NULL ELSE 'test' END,
               $4, '100', now(),
               CASE WHEN $5::double precision IS NULL THEN NULL
                    ELSE clock_timestamp() - make_interval(secs => $5::double precision) END,
               now() - interval '30 days', now() - interval '1 day')
       RETURNING id`,
      [workspaceId, owner, status, syncState, watermarkOffsetSeconds],
    );
    return rows[0]?.id ?? '';
  };

  const gateRefuses = async (mailboxId: string): Promise<boolean> => {
    const context = repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), database.session);
    return coverageRefusal(await readMailboxCoverage(context, { mailboxId })) !== null;
  };

  it('is owned and published by the mail lane', () => {
    expect(METRIC_OWNERS['MailboxCoverageAgeSeconds']).toBe('mail');
    expect(MAIL_METRIC_NAMES).toContain('MailboxCoverageAgeSeconds');
  });

  it('publishes nothing when no mailbox is connected and ready', async () => {
    await database.session.query('DELETE FROM mailboxes WHERE workspace_id = $1', [workspaceId]);
    expect(await mailboxCoverageAgeSeconds(database.session)).toBeNull();
    const data = await collectMailMetrics(database.session);
    expect(data.some(datum => datum.name === 'MailboxCoverageAgeSeconds')).toBe(false);

    await only('baseline_pending', 3600);
    expect(await mailboxCoverageAgeSeconds(database.session)).toBeNull();
    await only('recovering', 3600);
    expect(await mailboxCoverageAgeSeconds(database.session)).toBeNull();
    await only('ready', 3600, 'disconnected');
    expect(await mailboxCoverageAgeSeconds(database.session)).toBeNull();
  });

  it('crosses the window exactly when the gate starts holding', async () => {
    const cases: readonly { readonly label: string; readonly offset: number | null; readonly stale: boolean }[] = [
      { label: 'one minute old', offset: 60, stale: false },
      { label: 'fourteen minutes old', offset: 14 * 60, stale: false },
      { label: 'sixteen minutes old', offset: 16 * 60, stale: true },
      { label: 'an hour old', offset: 3600, stale: true },
      { label: 'no watermark on a ready mailbox', offset: null, stale: true },
      { label: 'one minute in the future', offset: -60, stale: false },
      { label: 'ten minutes in the future', offset: -600, stale: true },
    ];
    for (const entry of cases) {
      const mailboxId = await only('ready', entry.offset);
      const gauge = await mailboxCoverageAgeSeconds(database.session);
      expect(gauge, entry.label).not.toBeNull();
      expect((gauge ?? 0) > COVERAGE_FRESHNESS_SECONDS, `${entry.label}: the gauge`).toBe(entry.stale);
      expect(await gateRefuses(mailboxId), `${entry.label}: the gate`).toBe(entry.stale);
      expect(gauge ?? -1, entry.label).toBeGreaterThanOrEqual(0);
    }
  });

  it('reads the age itself when there is one, and one second past the window when there is not', async () => {
    await only('ready', 16 * 60);
    expect(await mailboxCoverageAgeSeconds(database.session)).toBeGreaterThanOrEqual(16 * 60);
    await only('ready', null);
    expect(await mailboxCoverageAgeSeconds(database.session)).toBe(COVERAGE_FRESHNESS_SECONDS + 1);
    await only('ready', -600);
    expect(await mailboxCoverageAgeSeconds(database.session)).toBe(COVERAGE_FRESHNESS_SECONDS + 1);
    await only('ready', -60);
    expect(await mailboxCoverageAgeSeconds(database.session)).toBe(0);
  });

  it('reports the stalest of several', async () => {
    await only('ready', 60);
    const { rows } = await database.session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-coverage-2', 'coverage2@example.test', 'Two') RETURNING id",
    );
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [workspaceId, rows[0]?.id ?? ''],
    );
    await database.session.query(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, sync_state, history_id, history_id_updated_at,
                              coverage_watermark_at, baseline_from_at, baseline_completed_at)
       VALUES ($1, $2, 'coverage2@example.test', 'ready', '100', now(), clock_timestamp() - interval '20 minutes',
               now() - interval '30 days', now() - interval '1 day')`,
      [workspaceId, rows[0]?.id ?? ''],
    );
    expect(await mailboxCoverageAgeSeconds(database.session)).toBeGreaterThanOrEqual(20 * 60);
    const data = await collectMailMetrics(database.session);
    const datum = data.find(entry => entry.name === 'MailboxCoverageAgeSeconds');
    expect(datum?.unit).toBe('Seconds');
    expect(datum?.value ?? 0).toBeGreaterThanOrEqual(20 * 60);
  });
});
