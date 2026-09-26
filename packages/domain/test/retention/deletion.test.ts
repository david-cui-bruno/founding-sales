import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { isSuppressed, recordingSuppressionJournal } from '../../suppression/index.ts';
import { commitDeletion, previewDeletion } from '../../retention/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';
import { seedRetention, type SeededRetention } from '../db/support/retentionFixtures.ts';

/**
 * The documented deletion workflow (specification 10.3).
 *
 * > A documented deletion workflow removes ordinary personal and correspondence data
 * > while retaining a minimal normalized suppression tombstone where needed to
 * > prevent renewed contact. Backup copies expire naturally under retention. Every
 * > deletion and export is audited.
 *
 * Four things therefore have to be true at once, and each has a test: the personal
 * and correspondence data is gone; the tombstone is there and effective; the
 * append-only business history is untouched; and the whole thing is audited and was
 * previewed first.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let mail: SeededMail;
let retention: SeededRetention;

const adminContext = (workspaceId: string, userId: string, db: SessionQueryable = database.session): RepositoryContext =>
  repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role: 'admin' }), db);

const salespersonContext = (
  workspaceId: string,
  userId: string,
  db: SessionQueryable = database.session,
): RepositoryContext =>
  repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role: 'salesperson' }), db);

const count = async (sql: string, values: readonly unknown[]): Promise<number> => {
  const { rows } = await database.session.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
};

/** A firm-level route and a contact-level one, so both shapes are in the preview. */
async function seedRoutes(workspaceId: string, firmId: string, contactId: string): Promise<void> {
  await database.session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at)
     VALUES ($1, $2, $3, 'dana@northwind.example.test', 'salesperson', now())`,
    [workspaceId, firmId, contactId],
  );
  await database.session.query(
    `INSERT INTO phone_routes (workspace_id, firm_id, contact_id, e164, source, retrieved_at)
     VALUES ($1, $2, $3, '+14015550144', 'salesperson', now())`,
    [workspaceId, firmId, contactId],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  mail = await seedMail(database.session, seeded, crm);
  retention = await seedRetention(database.session, seeded, crm, mail);
  await seedRoutes(seeded.alpha.workspaceId, crm.alpha.firmId, crm.alpha.contactId);
  await seedRoutes(seeded.beta.workspaceId, crm.beta.firmId, crm.beta.contactId);
});

afterAll(async () => {
  await database.drop();
});

describe('the deletion preview', () => {
  it('is admin only', async () => {
    const outcome = await previewDeletion(
      salespersonContext(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId),
      { targetKind: 'firm', firmId: crm.alpha.firmId },
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'admin_only' });
  });

  it('counts what a commit would remove and what it would keep, and deletes nothing', async () => {
    const before = await count('SELECT count(*) AS count FROM email_addresses WHERE workspace_id = $1', [
      seeded.alpha.workspaceId,
    ]);
    const outcome = await previewDeletion(adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId), {
      targetKind: 'firm',
      firmId: crm.alpha.firmId,
    });
    expect(outcome.ok).toBe(true);
    const preview = outcome.value;
    expect(preview?.previewHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(preview?.removes['email_addresses']).toBeGreaterThan(0);
    expect(preview?.removes['mail_messages']).toBeGreaterThan(0);
    expect(preview?.redacts['contacts']).toBeGreaterThan(0);
    // The append-only history is named as retained rather than left unmentioned: an
    // admin approving a deletion should be told what will still be there.
    expect(preview?.retains['opportunity_stage_events']).toBeGreaterThanOrEqual(0);
    expect(preview?.tombstoneHandles.length).toBeGreaterThan(0);

    expect(
      await count('SELECT count(*) AS count FROM email_addresses WHERE workspace_id = $1', [seeded.alpha.workspaceId]),
    ).toBe(before);
  });
});

describe('the deletion commit', () => {
  it('refuses a preview hash that no longer matches what is there', async () => {
    const context = adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId);
    const preview = await previewDeletion(context, { targetKind: 'firm', firmId: crm.alpha.firmId });
    const outcome = await commitDeletion(context, {
      requestId: preview.value?.requestId ?? '',
      previewHash: '0'.repeat(64),
      commandId: 'deletion-stale-preview',
      journal: recordingSuppressionJournal(),
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'preview_stale' });
  });

  it('removes personal and correspondence data, keeps business history, and leaves a tombstone that blocks renewed contact', async () => {
    const context = adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId);
    const journal = recordingSuppressionJournal();

    const stageEventsBefore = await count(
      'SELECT count(*) AS count FROM opportunity_stage_events WHERE workspace_id = $1',
      [seeded.alpha.workspaceId],
    );
    const auditBefore = await count('SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1', [
      seeded.alpha.workspaceId,
    ]);

    const preview = await previewDeletion(context, { targetKind: 'firm', firmId: crm.alpha.firmId });
    const outcome = await commitDeletion(context, {
      requestId: preview.value?.requestId ?? '',
      previewHash: preview.value?.previewHash ?? '',
      commandId: 'deletion-commit-1',
      journal,
    });
    expect(outcome.ok, outcome.reason).toBe(true);

    // Gone: routes, correspondence, bodies, evidence.
    expect(
      await count('SELECT count(*) AS count FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2', [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS count FROM phone_routes WHERE workspace_id = $1 AND firm_id = $2', [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
      ]),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS count FROM mail_messages m
           JOIN mail_message_matches x ON x.workspace_id = m.workspace_id AND x.mail_message_id = m.id
          WHERE m.workspace_id = $1 AND x.firm_id = $2`,
        [seeded.alpha.workspaceId, crm.alpha.firmId],
      ),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS count FROM evidence_items WHERE workspace_id = $1 AND firm_id = $2', [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
      ]),
    ).toBe(0);

    // Redacted in place, because append-only history references these rows and
    // 10.2's and 5.2's revoked privileges mean that history cannot be removed.
    const { rows: firmRows } = await database.session.query<{ name: string; website: string | null }>(
      'SELECT name, website FROM firms WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    expect(firmRows[0]?.name).not.toContain('Northwind');
    expect(firmRows[0]?.website).toBeNull();
    // The title too: since migration 0018 it is where a contact's LinkedIn URL lives.
    const { rows: contactRows } = await database.session.query<{ full_name: string; title: string | null }>(
      'SELECT full_name, title FROM contacts WHERE workspace_id = $1 AND firm_id = $2',
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    for (const row of contactRows) {
      expect(row.full_name).toBe('[deleted]');
      expect(row.title).toBeNull();
    }

    // Business history: still there, because nothing may delete it.
    expect(
      await count('SELECT count(*) AS count FROM opportunity_stage_events WHERE workspace_id = $1', [
        seeded.alpha.workspaceId,
      ]),
    ).toBe(stageEventsBefore);

    // The tombstone: minimal, normalized, effective, and journalled before the row.
    const tombstones = outcome.value?.tombstoneEventIds ?? [];
    expect(tombstones.length).toBeGreaterThan(0);
    expect(journal.appended.map(record => record.eventId)).toEqual(expect.arrayContaining([...tombstones]));
    expect(await isSuppressed(context, { scope: 'handle', canonicalKey: 'dana@northwind.example.test' })).not.toBeNull();
    expect(await isSuppressed(context, { scope: 'firm', canonicalKey: crm.alpha.firmId })).not.toBeNull();

    // Audited.
    expect(
      await count("SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1 AND action = 'deletion.committed'", [
        seeded.alpha.workspaceId,
      ]),
    ).toBe(1);
    expect(
      await count('SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1', [seeded.alpha.workspaceId]),
    ).toBeGreaterThan(auditBefore);

    // Nothing crossed. The other workspace's colliding firm is whole.
    expect(
      await count('SELECT count(*) AS count FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2', [
        seeded.beta.workspaceId,
        crm.beta.firmId,
      ]),
    ).toBeGreaterThan(0);
    const { rows: betaFirm } = await database.session.query<{ name: string }>(
      'SELECT name FROM firms WHERE workspace_id = $1 AND id = $2',
      [seeded.beta.workspaceId, crm.beta.firmId],
    );
    expect(betaFirm[0]?.name).toBe(crm.collidingFirmName);
    expect(
      await isSuppressed(adminContext(seeded.beta.workspaceId, seeded.beta.admin.userId), {
        scope: 'firm',
        canonicalKey: crm.beta.firmId,
      }),
    ).toBeNull();

    // And the retention fixture's tombstone is still there afterwards.
    expect(
      await count('SELECT count(*) AS count FROM suppression_events WHERE workspace_id = $1 AND event_id = $2', [
        seeded.alpha.workspaceId,
        retention.alpha.tombstoneEventId,
      ]),
    ).toBe(1);
  });

  it('refuses a second commit of the same request rather than deleting twice', async () => {
    const context = adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId);
    const { rows } = await database.session.query<{ id: string; preview_hash: string }>(
      "SELECT id, preview_hash FROM deletion_requests WHERE workspace_id = $1 AND state = 'committed' LIMIT 1",
      [seeded.alpha.workspaceId],
    );
    const outcome = await commitDeletion(context, {
      requestId: rows[0]?.id ?? '',
      previewHash: rows[0]?.preview_hash ?? '',
      commandId: 'deletion-commit-replay',
      journal: recordingSuppressionJournal(),
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'already_committed' });
  });
});
