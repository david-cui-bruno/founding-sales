import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { METRIC_OWNERS, collectJobMetrics, type MetricDatum } from '../../jobs/index.ts';
import { MAIL_METRIC_NAMES, collectMailMetrics, recordMailboxHeartbeat } from '../../mail/index.ts';
import { seedTwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * A mailbox nobody means to have connected is not a critically broken one (audit O15,
 * lane g81).
 *
 * `mailbox_heartbeat_missed` treats a missing `MailboxCheckHeartbeat` as a missed
 * check, and the job lane used to publish the metric from whatever mailbox heartbeat
 * rows existed. So an environment that had never connected a mailbox published nothing
 * and sat in critical ALARM; a mailbox its owner disconnected left a row that aged into
 * a zero and did the same; and either held the critical composite in ALARM over
 * everything else. The mail lane publishes it now, on every pass, over the mailboxes
 * that are supposed to be checked — the connected ones — and "none connected" is 1.
 *
 * ## The vacuous-pass trap, named
 *
 * A collector that published 1 whatever happened would pass every "is quiet" case
 * below. So the same database, in the same test, also holds a connected mailbox that
 * has never been checked and one whose check is stale, and each of those must read 0;
 * and the stale disconnected and revoked rows are real heartbeat rows, aged exactly
 * as the connected one is, so it is the mailbox status and nothing else that decides.
 */

const heartbeatOf = (data: readonly MetricDatum[]): number | undefined =>
  data.find(datum => datum.name === 'MailboxCheckHeartbeat')?.value;

describe('MailboxCheckHeartbeat asks about connected mailboxes (audit O15)', () => {
  let database: TestDatabase;
  let alpha: { workspaceId: string; salesperson: string; admin: string };

  beforeAll(async () => {
    database = await createTestDatabase();
    const seeded = await seedTwoWorkspaces(database.session);
    alpha = {
      workspaceId: seeded.alpha.workspaceId,
      salesperson: seeded.alpha.salesperson.userId,
      admin: seeded.alpha.admin.userId,
    };
  });

  afterAll(async () => {
    await database.drop();
  });

  const insertMailbox = async (
    ownerUserId: string,
    address: string,
    status: 'connected' | 'disconnected' | 'revoked',
  ): Promise<string> => {
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, status, disconnected_at, disconnect_reason,
                              sync_state, baseline_from_at, baseline_completed_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'connected' THEN NULL ELSE now() - interval '2 hours' END,
               CASE WHEN $4 = 'connected' THEN NULL ELSE 'test' END,
               'ready', now() - interval '30 days', now())
       RETURNING id`,
      [alpha.workspaceId, ownerUserId, address, status],
    );
    return rows[0]?.id ?? '';
  };

  const ageMailboxBeat = async (mailboxId: string, seconds: number): Promise<void> => {
    await database.session.query(
      `UPDATE heartbeats SET observed_at = now() - make_interval(secs => $2::double precision)
        WHERE component = 'mailbox' AND instance_key = $1`,
      [mailboxId, seconds],
    );
  };

  it('is owned by the mail lane and published by it alone', () => {
    expect(METRIC_OWNERS['MailboxCheckHeartbeat']).toBe('mail');
    expect(MAIL_METRIC_NAMES).toContain('MailboxCheckHeartbeat');
  });

  it('reads 1, not silence, when no mailbox has ever been connected', async () => {
    expect(heartbeatOf(await collectMailMetrics(database.session))).toBe(1);
    expect(heartbeatOf(await collectJobMetrics(database.session))).toBeUndefined();
  });

  it('does not count a mailbox its owner disconnected, or one whose grant was revoked', async () => {
    const disconnected = await insertMailbox(alpha.salesperson, 'owner-disconnected@example.test', 'disconnected');
    const revoked = await insertMailbox(alpha.admin, 'revoked@example.test', 'revoked');
    for (const mailboxId of [disconnected, revoked]) {
      await recordMailboxHeartbeat(database.session, { workspaceId: alpha.workspaceId, mailboxId });
      await ageMailboxBeat(mailboxId, 3600);
    }
    // Two stale rows, neither for a mailbox anything is meant to check.
    expect(heartbeatOf(await collectMailMetrics(database.session))).toBe(1);
    // The watch gauge is absent too, which its alarm reads as not breaching.
    expect((await collectMailMetrics(database.session)).some(datum => datum.name === 'GmailWatchHoursToExpiry')).toBe(false);

    // The same two mailboxes connected again: the same stale rows are now missed checks.
    await database.session.query(
      `UPDATE mailboxes SET status = 'connected', disconnected_at = NULL, disconnect_reason = NULL
        WHERE id = ANY ($1::uuid[])`,
      [[disconnected, revoked]],
    );
    expect(heartbeatOf(await collectMailMetrics(database.session))).toBe(0);

    // One of them checked on time is not enough: every connected mailbox must be.
    await recordMailboxHeartbeat(database.session, { workspaceId: alpha.workspaceId, mailboxId: disconnected });
    expect(heartbeatOf(await collectMailMetrics(database.session))).toBe(0);
    await recordMailboxHeartbeat(database.session, { workspaceId: alpha.workspaceId, mailboxId: revoked });
    expect(heartbeatOf(await collectMailMetrics(database.session))).toBe(1);

    await database.session.query(
      `UPDATE mailboxes SET status = 'disconnected', disconnected_at = now(), disconnect_reason = 'test'
        WHERE id = ANY ($1::uuid[])`,
      [[disconnected, revoked]],
    );
  });

  it('reads 0 for a connected mailbox that has never been checked', async () => {
    const { rows } = await database.session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-o15-new', 'new-o15@example.test', 'New') RETURNING id",
    );
    const owner = rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [alpha.workspaceId, owner],
    );
    await insertMailbox(owner, 'never-checked@example.test', 'connected');
    expect(heartbeatOf(await collectMailMetrics(database.session))).toBe(0);
  });
});
