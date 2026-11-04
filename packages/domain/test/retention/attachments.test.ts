import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { recordAccountSwitch } from '../../mail/accounts.ts';
import { gmailMessageUrl, readAttachmentReferences } from '../../retention/attachments.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { seedRetention, type SeededRetention } from '../db/support/retentionFixtures.ts';

/**
 * Attachments are metadata and a link (specification 10.3, section 2, Appendix F).
 *
 * > Attachments are not copied into FSS. FSS stores filename, media type, size,
 * > content hash when available, Gmail message reference, and authorization
 * > metadata. Authorized users open the original Gmail message to retrieve the file.
 *
 * Authorized links are checked through the actual content-read matrix below.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let mail: SeededMail;
let retention: SeededRetention;

const context = (
  workspaceId: string,
  userId: string,
  role: 'admin' | 'salesperson',
  db: SessionQueryable = database.session,
): RepositoryContext => repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role }), db);

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  mail = await seedMail(database.session, seeded, crm);
  retention = await seedRetention(database.session, seeded, crm, mail);
});

afterAll(async () => {
  await database.drop();
});

describe('the open-in-Gmail link is authorized', () => {
  it('gives the assigned salesperson the metadata and a link to the original message', async () => {
    const outcome = await readAttachmentReferences(
      context(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson'),
      { mailMessageId: retention.alpha.matchedMessageId },
    );
    expect(outcome.ok, outcome.reason).toBe(true);
    expect(outcome.value?.attachments).toEqual([
      { filename: 'terms.pdf', mediaType: 'application/pdf', sizeBytes: 900, contentHash: null, gmailAttachmentId: 'att-1' },
    ]);
    expect(outcome.value?.openInGmailUrl).toContain('mail.google.com');
    expect(outcome.value?.openInGmailUrl).toContain('retention_matched_history');
    // The link is a reference, not a copy: nothing in the answer carries bytes.
    expect(JSON.stringify(outcome.value)).not.toContain('data');
  });

  it('refuses a salesperson who is not the assignee and is not the mailbox owner', async () => {
    const outcome = await readAttachmentReferences(
      context(seeded.alpha.workspaceId, seeded.alpha.admin.userId, 'salesperson'),
      { mailMessageId: retention.alpha.matchedMessageId },
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'not_authorized' });
  });

  it('gives an admin the metadata and writes the access audit event 5.2 requires', async () => {
    const outcome = await readAttachmentReferences(
      context(seeded.alpha.workspaceId, seeded.alpha.admin.userId, 'admin'),
      { mailMessageId: retention.alpha.matchedMessageId },
    );
    expect(outcome.ok, outcome.reason).toBe(true);
    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_events
        WHERE workspace_id = $1 AND action = 'attachment.viewed' AND subject_id = $2`,
      [seeded.alpha.workspaceId, retention.alpha.matchedMessageId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('cannot reach the other workspace’s message of the same id', async () => {
    const outcome = await readAttachmentReferences(
      context(seeded.beta.workspaceId, seeded.beta.admin.userId, 'admin'),
      { mailMessageId: retention.alpha.matchedMessageId },
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'message_unknown' });
  });
});

describe('after a mailbox switch (call-to-booking A2)', () => {
  it('opens a message recorded under the old account in the old account, and a new one in the new', async () => {
    const owner = context(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson');
    const oldAddress = mail.alpha.address;
    const newAddress = 'switched.owner@example.test';
    await database.session.query('BEGIN');
    try {
      const { rows: provider } = await database.session.query<{ provider_message_id: string }>(
        'SELECT provider_message_id FROM mail_messages WHERE workspace_id = $1 AND id = $2',
        [seeded.alpha.workspaceId, retention.alpha.matchedMessageId],
      );
      // The switch as `completeGmailGrant` writes it: the intervals, then the row's address.
      await recordAccountSwitch(owner, {
        mailboxId: mail.alpha.mailboxId,
        fromAddress: oldAddress,
        toAddress: newAddress,
        toGeneration: 2,
        at: (await database.session.query<{ at: string }>('SELECT now()::text AS at')).rows[0]?.at ?? '',
      });
      await database.session.query(
        'UPDATE mailboxes SET email_address = $3, generation = 2 WHERE workspace_id = $1 AND id = $2',
        [seeded.alpha.workspaceId, mail.alpha.mailboxId, newAddress],
      );
      const old = await readAttachmentReferences(owner, { mailMessageId: retention.alpha.matchedMessageId });
      expect(old.value?.openInGmailUrl).toBe(gmailMessageUrl(oldAddress, provider[0]?.provider_message_id ?? ''));

      const { rows: fresh } = await database.session.query<{ id: string }>(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
                                    internal_date, matched)
         VALUES ($1, $2, 'new-account-message', 'new-account-thread', 'incoming', now() - interval '3 days', false)
         RETURNING id`,
        [seeded.alpha.workspaceId, mail.alpha.mailboxId],
      );
      const recent = await readAttachmentReferences(owner, { mailMessageId: fresh[0]?.id ?? '' });
      // Recorded after the switch — even though Gmail dates it before — so it is in the new account.
      expect(recent.value?.openInGmailUrl).toBe(gmailMessageUrl(newAddress, 'new-account-message'));
    } finally {
      await database.session.query('ROLLBACK');
    }
  });
});

