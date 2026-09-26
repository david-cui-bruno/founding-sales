import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { readAttachmentReferences } from '../../retention/attachments.ts';
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
 * Two halves again. The link is authorized — the read matrix gives message content
 * to the assigned salesperson, the mailbox owner and admins, and to nobody else —
 * and no code path anywhere stores the bytes. The second is asserted three ways,
 * because "we do not do that" is the kind of claim that stays true only while
 * somebody is checking: the database has nowhere to put them, the Gmail client has
 * no method that fetches them, and no source file names the endpoint that would.
 */

const REPOSITORY_ROOT = new URL('../../../../', import.meta.url).pathname;

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

describe('no code path stores attachment bytes', () => {
  it('has nowhere in the database to put them', async () => {
    const { rows } = await database.session.query<{ table_name: string; column_name: string; data_type: string }>(`
      SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         AND format_type(a.atttypid, a.atttypmod) = 'bytea'
    `);
    // The only bytea in the schema is the envelope-encrypted refresh token material
    // of `mailbox_tokens`. Nothing else in FSS stores bytes at all.
    expect([...new Set(rows.map(row => row.table_name))]).toEqual(['mailbox_tokens']);

    const { rows: references } = await database.session.query<{ data_type: string }>(`
      SELECT format_type(a.atttypid, a.atttypmod) AS data_type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = 'mail_messages' AND a.attname = 'attachment_references'
    `);
    expect(references[0]?.data_type).toBe('jsonb');
  });

  it('never names the Gmail endpoint that would return them', () => {
    // `users.messages.attachments.get` is the only Gmail call that returns attachment
    // bytes. A tree that never composes that path cannot fetch them by accident, and
    // a lane that starts to will fail here rather than in a retention review.
    //
    // The `/attachments/` half is checked only in files that speak to Gmail, because
    // this lane's own `POST /attachments/open` is a path in *this* API and matching it
    // would make the assertion about a string rather than about a request.
    const offenders: string[] = [];
    for (const root of ['packages/domain', 'packages/contracts', 'apps/api/src', 'apps/worker/src', 'apps/desktop/src']) {
      for (const file of typescriptFiles(join(REPOSITORY_ROOT, root))) {
        if (file.includes('/test/')) continue;
        const text = readFileSync(file, 'utf8');
        const namesTheMethod = /attachments\.get|getAttachment|fetchAttachment/u.test(text);
        const talksToGmail = /gmail\.googleapis\.com|GmailClient/u.test(text);
        if (namesTheMethod || (talksToGmail && /\/attachments\//u.test(text))) offenders.push(file);
      }
    }
    expect(offenders, 'a source file reaches for Gmail attachment bytes').toEqual([]);
  });

  it('gives the Gmail client no method that could return them', () => {
    // The port is the narrow waist: whatever a future adapter does, it can only do
    // what the interface lets a caller ask for, and no method here mentions an
    // attachment at all.
    const client = readFileSync(join(REPOSITORY_ROOT, 'packages/domain/mail/gmailClient.ts'), 'utf8');
    const methods = [...client.matchAll(/^\s{2}([a-zA-Z]+)\s*\(/gmu)].map(match => match[1] ?? '');
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.filter(name => /attach/iu.test(name))).toEqual([]);
  });

  it('describes an attachment with a reference and no payload field', async () => {
    const { rows } = await database.session.query<{ references: readonly Record<string, unknown>[] }>(
      'SELECT attachment_references AS references FROM mail_messages WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, retention.alpha.matchedMessageId],
    );
    for (const reference of rows[0]?.references ?? []) {
      expect(Object.keys(reference).sort()).toEqual(['attachmentId', 'filename', 'mimeType', 'sizeBytes']);
    }
  });
});

function typescriptFiles(directory: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (statSync(path).isDirectory()) found.push(...typescriptFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}
