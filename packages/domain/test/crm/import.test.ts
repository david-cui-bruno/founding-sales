import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext, type WorkspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import {
  IMPORT_COLUMNS as CONTRACT_COLUMNS,
  IMPORT_ISSUE_CODES as CONTRACT_ISSUE_CODES,
} from '@fss/contracts';
import { IMPORT_COLUMNS, IMPORT_ISSUE_CODES, commitImportRow, parseCsv, previewCsvImport } from '../../crm/import.ts';

/**
 * Admin CSV import (specification 7.2, Appendix G 38).
 *
 * "CSV import with duplicates, cross-workspace IDs, invalid routes, and partial
 * failures produces a preview and atomic per-row commands without leakage."
 *
 * Four clauses, and the last two are the ones a CRM usually gets wrong.
 *
 * **Atomic per row** means a row that creates a firm, a contact and two routes
 * either creates all four or none. The half-imported row — a firm with no contact,
 * because the phone number was rejected after the firm was written — is the state
 * nobody can clean up, because nothing records that the row was ever attempted.
 *
 * **Without leakage** means the preview may not tell an admin in one workspace
 * anything about the other. An external id that exists next door is *unknown* here,
 * in exactly the same words as an external id that exists nowhere.
 */
describe('CSV import', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;

  let admin: WorkspaceScope;
  let salesperson: WorkspaceScope;

  const context = (scope: WorkspaceScope): RepositoryContext => repositoryContext(scope, session);

  // The twelve columns the file had before lane g84 added `time_zone`: a file written to
  // the old list is still a file this one reads, because a header may name any subset.
  const csv = (...rows: readonly string[]): string =>
    [IMPORT_COLUMNS.filter(column => column !== 'time_zone').join(','), ...rows].join('\n');

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);

    // The colliding external id: the same string names a firm in beta and nothing
    // in alpha. An import into alpha must not see beta's, and must not match it.
    await session.query(
      `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value)
       VALUES ($1, 'firm', $2, 'external_id', 'LEGACY-0001')`,
      [seeded.beta.workspaceId, crm.beta.firmId],
    );

    admin = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.admin.userId,
      role: 'admin',
    });
    salesperson = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  // ------------------------------------------------------------ the wire contract
  it('agrees with @fss/contracts about the columns and the issue codes', () => {
    // Two packages, one vocabulary. A column added to one and not the other is a
    // preview whose `issues` a client cannot render, and it fails here instead.
    expect([...IMPORT_COLUMNS]).toEqual([...CONTRACT_COLUMNS]);
    expect([...IMPORT_ISSUE_CODES]).toEqual([...CONTRACT_ISSUE_CODES]);
  });

  // ------------------------------------------------------------------ the parser
  it('parses quoted fields, embedded commas, quotes and newlines', () => {
    const parsed = parseCsv('firm_name,website\n"one, two","he said ""hi"""\n"line\nbreak",plain\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.header).toEqual(['firm_name', 'website']);
    expect(parsed.value.rows).toEqual([
      { number: 2, fields: ['one, two', 'he said "hi"'] },
      { number: 3, fields: ['line\nbreak', 'plain'] },
    ]);
  });

  it('refuses a file with no header, an unknown column, or a row of the wrong width', () => {
    expect(previewShape('')).toBe('csv_empty');
    expect(previewShape('firm_name,mystery\nA,B')).toBe('csv_column_unknown');
    expect(previewShape('firm_name\nA,B')).toBe('csv_row_width');
  });

  function previewShape(source: string): string {
    const parsed = parseCsv(source);
    return parsed.ok ? 'ok' : parsed.reason;
  }

  // ------------------------------------------------------------- admin-only (5.2)
  it('refuses a salesperson before it reads a byte of the file', async () => {
    const outcome = await previewCsvImport(context(salesperson), { csv: csv('Anything Test Co,,,,,,,,,,,') });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('admin_only');
  });

  // ---------------------------------------------------------- Appendix G 38: preview
  it('previews duplicates, cross-workspace ids, invalid routes and good rows together', async () => {
    const source = csv(
      // 2: a clean row.
      'Gorse & Vale Test Ltd,https://gorse.example.test,9 Sample Street,Providence,RI,02903,NEW-1,,Alex Placeholder,Partner,alex@gorse.example.test,+14015550101',
      // 3: the same firm again, inside the same file.
      'Gorse & Vale Test Ltd,https://gorse.example.test,,,,,NEW-1,,,,,',
      // 4: a firm that already exists in this workspace.
      `${crm.collidingFirmName},https://northwind.example.test,,,,,,,,,,`,
      // 5: an external id that names a firm in the workspace next door.
      'Beta Shadow Test Co,,,,,,LEGACY-0001,,,,,',
      // 6: an unusable phone number and a malformed address.
      'Thistle Test Works,,,,,,,,Robin Placeholder,,robin@@thistle,555-CALL-NOW',
      // 7: a row with no firm name at all.
      ',https://nameless.example.test,,,,,,,,,,',
    );
    const preview = await previewCsvImport(context(admin), { csv: source });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const byRow = new Map(preview.value.rows.map(row => [row.rowNumber, row]));
    expect(byRow.get(2)?.outcome).toBe('create');
    expect(byRow.get(2)?.issues).toEqual([]);

    expect(byRow.get(3)?.outcome).toBe('duplicate');
    expect(byRow.get(3)?.issues.map(issue => issue.code)).toEqual(['duplicate_in_file']);

    expect(byRow.get(4)?.outcome).toBe('duplicate');
    expect(byRow.get(4)?.issues.map(issue => issue.code)).toEqual(['duplicate_in_workspace']);

    // The external id belongs to beta. Alpha is told it is new, not that it exists.
    expect(byRow.get(5)?.outcome).toBe('create');
    expect(byRow.get(5)?.issues).toEqual([]);

    expect(byRow.get(6)?.outcome).toBe('invalid');
    expect(byRow.get(6)?.issues.map(issue => issue.code).sort()).toEqual(['email_invalid', 'phone_invalid']);

    expect(byRow.get(7)?.outcome).toBe('invalid');
    expect(byRow.get(7)?.issues.map(issue => issue.code)).toEqual(['firm_name_missing']);

    expect(preview.value.counts).toEqual({ create: 2, attach: 0, duplicate: 2, invalid: 2 });
  });

  it('says nothing about the workspace next door, in the whole preview', async () => {
    const preview = await previewCsvImport(context(admin), {
      csv: csv('Beta Shadow Test Co,,,,,,LEGACY-0001,,,,,', `,,,,,,,${seeded.beta.salesperson.userId},,,,`),
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const serialized = JSON.stringify(preview.value);
    expect(serialized).not.toContain(seeded.beta.workspaceId);
    expect(serialized).not.toContain(crm.beta.firmId);
    // A member of the other workspace is an unknown owner here, not "somebody else's".
    expect(preview.value.rows[1]?.issues.map(issue => issue.code)).toContain('owner_unknown');
  });

  it('writes nothing at all: a preview is a read', async () => {
    const before = await count('firms');
    await previewCsvImport(context(admin), { csv: csv('Preview Only Test Co,,,,,,,,,,,') });
    expect(await count('firms')).toBe(before);
  });

  // ----------------------------------------------------- Appendix G 38: the commit
  it('commits a row atomically: the firm, the contact and both routes, or none of them', async () => {
    const preview = await previewCsvImport(context(admin), {
      csv: csv(
        'Marram Test Partners,https://marram.example.test,3 Sample Lane,Providence,RI,02903,MAR-1,,Sam Placeholder,Director,sam@marram.example.test,+14015550102',
      ),
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const row = preview.value.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const committed = await commitImportRow(context(admin), row);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.contactId).not.toBeNull();
    expect(committed.value.routeIds).toHaveLength(2);

    const firmId = committed.value.firmId;
    expect(await count('contacts', firmId)).toBe(1);
    expect(await count('email_addresses', firmId)).toBe(1);
    expect(await count('phone_routes', firmId)).toBe(1);
    const alias = await session.query<{ alias_value: string }>(
      "SELECT alias_value FROM record_aliases WHERE workspace_id = $1 AND firm_id = $2 AND alias_kind = 'external_id'",
      [seeded.alpha.workspaceId, firmId],
    );
    expect(alias.rows.map(entry => entry.alias_value)).toEqual(['MAR-1']);
  });

  it('refuses to commit a row the preview called invalid or duplicate, naming its code and column', async () => {
    const preview = await previewCsvImport(context(admin), {
      csv: csv(',https://nameless.example.test,,,,,,,,,,', `${crm.collidingFirmName},,,,,,,,,,,`),
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const reasons: [number | null, string, string | null][] = [];
    for (const row of preview.value.rows) {
      const committed = await commitImportRow(context(admin), row);
      expect(committed.ok, String(row.rowNumber)).toBe(false);
      if (!committed.ok) reasons.push([committed.rowNumber, committed.reason, committed.column]);
    }
    // Lane g84: the refusal is the row's own fault, where it is, rather than `invalid_input`.
    expect(reasons).toEqual([
      [2, 'firm_name_missing', 'firm_name'],
      [3, 'duplicate_in_workspace', 'firm_name'],
    ]);
  });

  it('rolls the whole row back when one of its parts fails, leaving no half-firm', async () => {
    const preview = await previewCsvImport(context(admin), {
      csv: csv('Sedge Test Holdings,,,,,,,,Jo Placeholder,,jo@sedge.example.test,+14015550103'),
    });
    expect(preview.ok && preview.value.rows[0]).toBeDefined();
    if (!preview.ok) return;
    const row = preview.value.rows[0];
    if (row === undefined) return;

    // The commit runs inside the caller's transaction, so a failure in any part of
    // the row leaves the row's own work rolled back. The preview passed, so the
    // failure has to be injected: an owner that is removed between the two steps.
    const broken = { ...row, firm: { ...row.firm, ownerUserId: '00000000-0000-4000-8000-000000000000' } };
    const before = await count('firms');
    await session.query('BEGIN');
    const committed = await commitImportRow(context(admin), broken);
    await session.query('ROLLBACK');
    expect(committed.ok).toBe(false);
    if (!committed.ok) expect(committed.reason).toBe('assignee_unknown');
    expect(await count('firms')).toBe(before);
  });

  it('never writes into the workspace next door, whatever the file says', async () => {
    const betaFirmsBefore = await count('firms', undefined, seeded.beta.workspaceId);
    const preview = await previewCsvImport(context(admin), {
      csv: csv(`Crosser Test Co,,,,,,${'LEGACY-0001'},,,,,`),
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const row = preview.value.rows[0];
    if (row === undefined) return;
    const committed = await commitImportRow(context(admin), row);
    expect(committed.ok).toBe(true);

    expect(await count('firms', undefined, seeded.beta.workspaceId)).toBe(betaFirmsBefore);
    // Both workspaces now carry the same external id, on different firms.
    const aliases = await session.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM record_aliases WHERE alias_kind = 'external_id' AND alias_value = 'LEGACY-0001'",
    );
    expect(aliases.rows).toHaveLength(2);
  });

  async function count(table: string, firmId?: string, workspaceId?: string): Promise<number> {
    const where = firmId === undefined ? '' : ' AND firm_id = $2';
    const { rows } = await session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE workspace_id = $1${where}`,
      firmId === undefined ? [workspaceId ?? seeded.alpha.workspaceId] : [workspaceId ?? seeded.alpha.workspaceId, firmId],
    );
    return Number(rows[0]?.count ?? '0');
  }
});
