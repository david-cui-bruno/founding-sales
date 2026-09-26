import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { collectOutboundMetrics, mailboxDisconnectedHours } from '../../outbound/metrics.ts';
import { seedTwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * `MailboxDisconnectedHours` counts a grant that was lost, not a mailbox its owner
 * disconnected (audit O15, lane g81).
 *
 * 12.6 alarms on "a mailbox that sent in the last 30 days and remains disconnected for
 * 48 hours". The query read `status IN ('disconnected', 'revoked')`, so a salesperson who
 * disconnected their own mailbox with the disconnect command — which writes
 * `disconnected` — raised the critical alarm two days later. A refused refresh
 * (`holdForRevokedGrant`) and a departure write `revoked`, and those are what the alarm
 * is for.
 *
 * ## The vacuous-pass trap, named
 *
 * A query that never returned anything would pass the "owner disconnected" case. So the
 * same database holds a revoked mailbox with a recent send, which must read at least its
 * 50 hours, and a revoked mailbox that never sent, which must not. Only one mailbox is
 * present at a time, because the gauge is a maximum.
 */

describe('MailboxDisconnectedHours (audit O15)', () => {
  let database: TestDatabase;
  let workspaceId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const seeded = await seedTwoWorkspaces(database.session);
    workspaceId = seeded.alpha.workspaceId;
    ownerUserId = seeded.alpha.salesperson.userId;
  });

  afterAll(async () => {
    await database.drop();
  });

  const only = async (status: 'disconnected' | 'revoked', options: { readonly sentRecently: boolean }): Promise<void> => {
    await database.session.query('DELETE FROM mail_messages WHERE workspace_id = $1', [workspaceId]);
    await database.session.query('DELETE FROM mailboxes WHERE workspace_id = $1', [workspaceId]);
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, status, disconnected_at, disconnect_reason)
       VALUES ($1, $2, 'o15@example.test', $3, now() - interval '50 hours', 'test')
       RETURNING id`,
      [workspaceId, ownerUserId, status],
    );
    if (options.sentRecently) {
      await database.session.query(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction, internal_date)
         VALUES ($1, $2, 'o15-send-1', 'o15-thread-1', 'outgoing', now() - interval '7 days')`,
        [workspaceId, rows[0]?.id ?? ''],
      );
    }
  };

  it('counts a revoked grant on a mailbox that sent in the last 30 days', async () => {
    await only('revoked', { sentRecently: true });
    expect(await mailboxDisconnectedHours(database.session)).toBeGreaterThanOrEqual(50);
    const data = await collectOutboundMetrics(database.session);
    expect(data.find(datum => datum.name === 'MailboxDisconnectedHours')?.value ?? 0).toBeGreaterThanOrEqual(50);
  });

  it('does not count a mailbox its owner disconnected, however recently it sent', async () => {
    await only('disconnected', { sentRecently: true });
    expect(await mailboxDisconnectedHours(database.session)).toBeNull();
    expect((await collectOutboundMetrics(database.session)).some(datum => datum.name === 'MailboxDisconnectedHours')).toBe(false);
  });

  it('does not count a revoked mailbox that has not sent in 30 days', async () => {
    await only('revoked', { sentRecently: false });
    expect(await mailboxDisconnectedHours(database.session)).toBeNull();
  });
});
