import { describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope } from '@fss/domain/db';
import { createTestDatabase } from '@fss/domain/db/testing';
import {
  CARRY_TEMPLATE_SEAM,
  CarryTemplateSeamError,
  importTemplateVersions,
  templateVersionDrafts,
} from '../../tools/carry/templates.ts';
import { readOldRecord } from '../../tools/carry/oldShapes.ts';
import { goodOldTable } from '../fixtures/carry/oldTable.ts';

/**
 * The template half of the carry (specification 2 "Data carry" and 17; lane G11).
 *
 * "unapproved template bodies from the old table" is a contract this lane can only
 * half keep. The reader and the manifest are here and finished; the write is not,
 * because `template_versions` arrives with migration 0009 and no lane may add a
 * migration out of the coordinator's order.
 *
 * The skipped test below is the whole of the unfinished work, written as the
 * assertion it will become. `docs/decisions/g11-template-importer-seam.md` says what
 * has to be true for `it.skip` to become `it`.
 */

const records = goodOldTable().flatMap(item => {
  const read = readOldRecord(item);
  return read.ok && read.value.kind === 'template' ? [read.value] : [];
});

describe('the template reader and manifest side', () => {
  it('reads every template the old table holds', () => {
    expect(records.map(record => record.oldId)).toEqual(['T1', 'T2']);
  });

  it('carries every body as an unapproved version, whatever the old approval said', () => {
    const drafts = templateVersionDrafts(records);
    expect(drafts).toHaveLength(2);
    expect(drafts.every(draft => draft.approvedAt === null)).toBe(true);
    expect(drafts.every(draft => draft.approvedByUserId === null)).toBe(true);
    expect(drafts.every(draft => draft.retiredAt === null)).toBe(true);
    // The old postal address travelled with the old approval and is not an approval
    // of anything here; the greenfield footer is configuration, not template text.
    expect(drafts.every(draft => draft.footerPostalAddress === null)).toBe(true);
  });

  it('carries the old revision as the version, and hashes the text it carries', () => {
    const drafts = templateVersionDrafts(records);
    expect(drafts.map(draft => [draft.templateId, draft.version])).toEqual([
      ['T1', 1],
      ['T2', 2],
    ]);
    expect(drafts.every(draft => /^[0-9a-f]{64}$/u.test(draft.contentHash))).toBe(true);
  });

  it('names the migration the writer waits for', () => {
    expect(CARRY_TEMPLATE_SEAM.migration).toBe('0009_mail.sql');
    expect(CARRY_TEMPLATE_SEAM.table).toBe('template_versions');
  });

  it('refuses to pretend it wrote anything', async () => {
    const database = await createTestDatabase();
    try {
      const workspace = await database.session.query<{ id: string }>(
        "INSERT INTO workspaces (slug, display_name) VALUES ('carry-templates', 'Templates') RETURNING id",
      );
      const context = repositoryContext(
        workspaceScope(workspace.rows[0]?.id ?? '', { kind: 'system', component: 'migration' }),
        database.session,
      );
      await expect(importTemplateVersions(context, templateVersionDrafts(records))).rejects.toBeInstanceOf(
        CarryTemplateSeamError,
      );
    } finally {
      await database.drop();
    }
  }, 120_000);
});

/**
 * Unfinished (lane G11). This is the acceptance the template half owes, and it fails
 * until migration 0009 lands `template_versions`. Turn `it.skip` into `it`, delete
 * the throw in `importTemplateVersions`, and this is the whole of the remaining work.
 */
describe('the template importer, once template_versions exists', () => {
  it.skip('writes one unapproved version per old template and is idempotent', async () => {
    const database = await createTestDatabase();
    try {
      const workspace = await database.session.query<{ id: string }>(
        "INSERT INTO workspaces (slug, display_name) VALUES ('carry-templates-live', 'Templates') RETURNING id",
      );
      const workspaceId = workspace.rows[0]?.id ?? '';
      const context = repositoryContext(
        workspaceScope(workspaceId, { kind: 'system', component: 'migration' }),
        database.session,
      );
      const drafts = templateVersionDrafts(records);

      const first = await importTemplateVersions(context, drafts);
      expect(first).toEqual({ created: 2, reused: 0, deferred: 0 });
      const second = await importTemplateVersions(context, drafts);
      expect(second).toEqual({ created: 0, reused: 2, deferred: 0 });

      const rows = await database.session.query<{ template_id: string; version: number; approved_at: string | null }>(
        `SELECT template_id, version, approved_at FROM template_versions
          WHERE workspace_id = $1 ORDER BY template_id`,
        [workspaceId],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.every(row => row.approved_at === null)).toBe(true);
    } finally {
      await database.drop();
    }
  }, 120_000);
});
