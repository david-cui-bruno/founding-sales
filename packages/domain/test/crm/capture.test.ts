import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import {
  repositoryContext,
  workspaceScope,
  type RepositoryContext,
  type WorkspaceScope,
} from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { IMPORT_COLUMNS } from '@fss/contracts';
import {
  addFirm,
  canonicalWebsite,
  commitImportRow,
  parseCsv,
  previewCsvImport,
  websiteDomain,
  type ImportPreviewRow,
} from '../../crm/import.ts';

/**
 * Capturing firms from the desktop (audit item G02): one row per contact, the
 * duplicate rules, and the Add firm form that is one row of an import.
 *
 * `import.test.ts` keeps Appendix G 38's four defects in one file. This file is about
 * what a founder's spreadsheet looks like: a line per person, the firm's columns
 * repeated, a firm that may already be here, and a person who may already be at it.
 *
 * **The vacuous-pass trap for "attach".** A file whose every row names a different firm
 * passes any rule about repeated firms, because none repeats. Every file below repeats a
 * firm on purpose, and one repeats it by domain with a different spelling of its name.
 *
 * No real business name, address or number appears here: `example.test` is reserved by
 * RFC 6761 and the numbers are in the NANP 555-01XX fictional block.
 */
describe('capturing firms: one row per contact, and Add firm', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let admin: WorkspaceScope;
  let salesperson: WorkspaceScope;

  const context = (scope: WorkspaceScope): RepositoryContext => repositoryContext(scope, session);
  const header = IMPORT_COLUMNS.join(',');
  /** A row by column name, so each case says only what it is about. */
  const row = (values: Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>): string =>
    IMPORT_COLUMNS.map(column => {
      const value = values[column] ?? '';
      return /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    }).join(',');
  const csv = (...rows: readonly string[]): string => [header, ...rows].join('\n');

  const preview = async (source: string): Promise<readonly ImportPreviewRow[]> => {
    const outcome = await previewCsvImport(context(admin), { csv: source });
    if (!outcome.ok) throw new Error(`preview refused: ${outcome.reason}`);
    return outcome.value.rows;
  };

  /** Commit every committable row in order, the way the API route does. */
  const commitAll = async (rows: readonly ImportPreviewRow[]) => {
    const committed = new Map<number, string>();
    const results = [];
    for (const entry of rows) {
      if (entry.outcome !== 'create' && entry.outcome !== 'attach') continue;
      const outcome = await commitImportRow(context(admin), entry, { committedFirmIds: committed });
      if (outcome.ok) committed.set(entry.rowNumber, outcome.value.firmId);
      results.push(outcome);
    }
    return results;
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);
    admin = workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' });
    salesperson = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  // ---------------------------------------------------------------- the file itself
  it('reads a spreadsheet header: a byte-order mark, spaces and capitals', () => {
    const parsed = parseCsv('﻿Firm Name,Website,Contact-Email\r\nBirch Test Advisors,birch.example.test,a@birch.example.test\r\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.header).toEqual(['firm_name', 'website', 'contact_email']);
  });

  it('names the header or the line a refused file is wrong at', () => {
    expect(parseCsv('firm_name,notes\nBirch,hello')).toEqual({
      ok: false,
      reason: 'csv_column_unknown',
      column: 'notes',
      rowNumber: null,
    });
    expect(parseCsv('firm_name,Firm name\nBirch,Birch')).toMatchObject({ ok: false, reason: 'csv_column_repeated', column: 'firm_name' });
    // A blank line still counts: the ragged row is the spreadsheet's line 4.
    expect(parseCsv('firm_name,website\nBirch,\n,\nAsh')).toMatchObject({ ok: false, reason: 'csv_row_width', rowNumber: 4 });
  });

  it('accepts a bare domain as a website, and matches on the domain without www', () => {
    expect(canonicalWebsite('www.birch.example.test/about')).toBe('https://www.birch.example.test/about');
    expect(canonicalWebsite('HTTP://Birch.example.test')).toBe('http://Birch.example.test');
    expect(canonicalWebsite('not a site')).toBe('invalid');
    expect(canonicalWebsite('localhost')).toBe('invalid');
    expect(websiteDomain('https://WWW.Birch.example.test/about')).toBe('birch.example.test');
  });

  // -------------------------------------------------------------- one row per contact
  it('creates a firm on its first row and adds the next rows’ contacts to it, by domain then by name', async () => {
    const rows = await preview(
      csv(
        row({ firm_name: 'Aspen Test Wealth', website: 'aspen.example.test', region_code: 'RI', postal_code: '02903', contact_name: 'Kim Placeholder', contact_email: 'kim@aspen.example.test', contact_phone: '401-555-0121' }),
        // The same firm by its domain, spelled differently.
        row({ firm_name: 'Aspen Test Wealth LLC', website: 'https://www.aspen.example.test', contact_name: 'Lee Placeholder', contact_email: 'lee@aspen.example.test' }),
        // The same firm by name, with no website to contradict it.
        row({ firm_name: 'aspen  test wealth', contact_name: 'Pat Placeholder' }),
        // The same person again: nothing new.
        row({ firm_name: 'Aspen Test Wealth', website: 'aspen.example.test', contact_name: 'Kim P.', contact_email: 'KIM@aspen.example.test' }),
        // Only the firm again: nothing new either.
        row({ firm_name: 'Aspen Test Wealth', website: 'aspen.example.test' }),
      ),
    );
    expect(rows.map(entry => [entry.rowNumber, entry.outcome])).toEqual([
      [2, 'create'],
      [3, 'attach'],
      [4, 'attach'],
      [5, 'duplicate'],
      [6, 'duplicate'],
    ]);
    expect(rows[1]?.match).toEqual({ kind: 'in_file', rowNumber: 2, matchedOn: 'domain' });
    expect(rows[2]?.match).toEqual({ kind: 'in_file', rowNumber: 2, matchedOn: 'name' });
    expect(rows[3]?.issues).toEqual([{ column: 'contact_email', code: 'duplicate_in_file' }]);
    expect(rows[4]?.issues).toEqual([{ column: 'website', code: 'duplicate_in_file' }]);

    const results = await commitAll(rows);
    expect(results.map(result => (result.ok ? result.value.outcome : result.reason))).toEqual(['created', 'attached', 'attached']);
    const firmIds = new Set(results.map(result => (result.ok ? result.value.firmId : '')));
    expect(firmIds.size).toBe(1);
    const firmId = [...firmIds][0] ?? '';

    const people = await session.query<{ full_name: string; is_primary: boolean }>(
      'SELECT full_name, is_primary FROM contacts WHERE workspace_id = $1 AND firm_id = $2 ORDER BY full_name',
      [seeded.alpha.workspaceId, firmId],
    );
    expect(people.rows).toEqual([
      { full_name: 'Kim Placeholder', is_primary: true },
      { full_name: 'Lee Placeholder', is_primary: false },
      { full_name: 'Pat Placeholder', is_primary: false },
    ]);

    // Assigned to the admin who imported it: an unassigned firm cannot be dialed by anyone.
    const firm = await session.query<{ assigned_user_id: string; time_zone: string; time_zone_source: string }>(
      'SELECT assigned_user_id, time_zone, time_zone_source FROM firms WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, firmId],
    );
    expect(firm.rows[0]).toEqual({ assigned_user_id: seeded.alpha.admin.userId, time_zone: 'America/New_York', time_zone_source: 'state_default' });

    // Imported addresses are candidates until the worker checks them; an imported phone
    // number is usable on entry (wave 2, S4.4), with the evidence 0004's CHECK asks for.
    const routes = await session.query<{ kind: string; eligibility: string; source: string; evidenced: boolean }>(
      `SELECT 'email' AS kind, eligibility, source, false AS evidenced
         FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2
       UNION ALL
       SELECT 'phone', eligibility, source,
              technical_validation = 'passed' AND association_confidence IS NOT NULL
              AND eligibility_policy_version = 'phone-on-entry.1'
         FROM phone_routes WHERE workspace_id = $1 AND firm_id = $2`,
      [seeded.alpha.workspaceId, firmId],
    );
    expect(routes.rows).toHaveLength(3);
    expect(routes.rows.every(route => route.source === 'import')).toBe(true);
    expect(routes.rows.filter(route => route.kind === 'email').every(route => route.eligibility === 'candidate')).toBe(true);
    const phones = routes.rows.filter(route => route.kind === 'phone');
    expect(phones.length).toBeGreaterThan(0);
    expect(phones.every(route => route.eligibility === 'usable' && route.evidenced)).toBe(true);
  });

  it('adds a new person to a firm already here, and refuses one who is already at it by email or by name', async () => {
    const rows = await preview(
      csv(
        row({ firm_name: crm.collidingFirmName, website: 'northwind.example.test', contact_name: 'Sam Placeholder', contact_email: 'sam@northwind.example.test' }),
        row({ firm_name: 'Northwind', website: 'northwind.example.test', contact_name: 'Dana E.', contact_email: crm.collidingEmail }),
        row({ firm_name: crm.collidingFirmName, contact_name: '  dana   EXAMPLE ' }),
      ),
    );
    expect(rows.map(entry => entry.outcome)).toEqual(['attach', 'duplicate', 'duplicate']);
    expect(rows[0]?.match).toEqual({ kind: 'existing', firmId: crm.alpha.firmId, firmName: crm.collidingFirmName, matchedOn: 'domain' });
    expect(rows[1]?.issues).toEqual([{ column: 'contact_email', code: 'duplicate_in_workspace' }]);
    expect(rows[2]?.issues).toEqual([{ column: 'contact_name', code: 'duplicate_in_workspace' }]);

    const [result] = await commitAll(rows);
    expect(result?.ok && result.value.firmId).toBe(crm.alpha.firmId);
    expect(result?.ok && result.value.outcome).toBe('attached');
    const primary = await session.query<{ full_name: string }>(
      'SELECT full_name FROM contacts WHERE workspace_id = $1 AND firm_id = $2 AND is_primary',
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    expect(primary.rows.map(entry => entry.full_name)).toEqual(['Dana Example']);

    // The same row again, committed after it landed, is a duplicate at commit time too.
    const again = await commitImportRow(context(admin), rows[0] as ImportPreviewRow);
    expect(again).toMatchObject({ ok: false, reason: 'duplicate_in_workspace', column: 'contact_email', firmId: crm.alpha.firmId });
  });

  it('treats the same name with a different website as a different firm', async () => {
    const rows = await preview(csv(row({ firm_name: crm.collidingFirmName, website: 'northwind-west.example.test' })));
    expect(rows[0]?.outcome).toBe('create');
    expect(rows[0]?.match).toBeNull();
  });

  it('refuses a row whose website names two firms here, which only a merge can settle', async () => {
    for (const name of ['Twin Test Partners', 'Twin Test Partners East']) {
      await session.query(
        `INSERT INTO firms (workspace_id, name, website) VALUES ($1, $2, 'https://twin.example.test')`,
        [seeded.alpha.workspaceId, name],
      );
    }
    const rows = await preview(csv(row({ firm_name: 'Twin', website: 'twin.example.test', contact_name: 'Jo Placeholder' })));
    expect(rows[0]?.outcome).toBe('invalid');
    expect(rows[0]?.issues).toEqual([{ column: 'website', code: 'firm_ambiguous' }]);
  });

  it('records a zone the row names, and refuses one no clock knows', async () => {
    const rows = await preview(
      csv(
        row({ firm_name: 'Cedar Test Capital', time_zone: 'America/Chicago' }),
        row({ firm_name: 'Moon Test Capital', time_zone: 'Mars/Olympus_Mons' }),
        row({ firm_name: 'x'.repeat(301) }),
      ),
    );
    expect(rows.map(entry => entry.outcome)).toEqual(['create', 'invalid', 'invalid']);
    expect(rows[1]?.issues).toEqual([{ column: 'time_zone', code: 'time_zone_invalid' }]);
    expect(rows[2]?.issues).toEqual([{ column: 'firm_name', code: 'too_long' }]);
    const [created] = await commitAll(rows);
    const firmId = created?.ok ? created.value.firmId : '';
    const zone = await session.query<{ time_zone: string; time_zone_source: string; time_zone_confidence: string }>(
      'SELECT time_zone, time_zone_source, time_zone_confidence FROM firms WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, firmId],
    );
    expect(zone.rows[0]).toEqual({ time_zone: 'America/Chicago', time_zone_source: 'recorded', time_zone_confidence: 'high' });
  });

  it('commits a row whose creating row was not committed by making the firm from its own columns', async () => {
    const rows = await preview(
      csv(
        row({ firm_name: 'Rowan Test Group', website: 'rowan.example.test', contact_name: 'Ari Placeholder' }),
        row({ firm_name: 'Rowan Test Group', website: 'rowan.example.test', contact_name: 'Bo Placeholder' }),
      ),
    );
    const second = rows[1];
    expect(second?.outcome).toBe('attach');
    if (second === undefined) return;
    const committed = await commitImportRow(context(admin), second, { committedFirmIds: new Map() });
    expect(committed.ok && committed.value.outcome).toBe('created');
  });

  it('takes a row’s firm back with it when a later part of the row is refused', async () => {
    const [clean] = await preview(csv(row({ firm_name: 'Linden Test Advisors', contact_name: 'Cy Placeholder' })));
    if (clean === undefined) throw new Error('no row');
    // A contact the form could never send — a name of spaces — refused by `createContact`
    // after `createFirm` has written the firm. The savepoint is what takes the firm back.
    const doctored: ImportPreviewRow = { ...clean, contact: { fullName: '   ', title: null } };
    const before = await count('firms');
    const committed = await commitImportRow(context(admin), doctored);
    expect(committed).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(await count('firms')).toBe(before);
  });

  // ------------------------------------------------------------------------ Add firm
  it('adds a firm with its first contact for a salesperson, assigned to them, the phone usable at once', async () => {
    const added = await addFirm(context(salesperson), {
      firm: { name: 'Maple Test Planning', website: 'maple.example.test', timeZone: 'America/New_York' },
      contact: { fullName: 'Rae Placeholder', title: 'Founder', email: 'Rae@Maple.example.test', phone: '(401) 555-0122' },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.routeIds).toHaveLength(2);
    const firm = await session.query<{ assigned_user_id: string; website: string; time_zone: string }>(
      'SELECT assigned_user_id, website, time_zone FROM firms WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, added.value.firmId],
    );
    expect(firm.rows[0]).toEqual({
      assigned_user_id: seeded.alpha.salesperson.userId,
      website: 'https://maple.example.test',
      time_zone: 'America/New_York',
    });
    const routes = await session.query<{ value: string; eligibility: string; source: string }>(
      `SELECT address AS value, eligibility, source FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2
       UNION ALL SELECT e164, eligibility, source FROM phone_routes WHERE workspace_id = $1 AND firm_id = $2
       ORDER BY value`,
      [seeded.alpha.workspaceId, added.value.firmId],
    );
    expect(routes.rows).toEqual([
      { value: '+14015550122', eligibility: 'usable', source: 'salesperson' },
      { value: 'rae@maple.example.test', eligibility: 'candidate', source: 'salesperson' },
    ]);
  });

  it('names every field at fault, and writes nothing', async () => {
    const before = await count('firms');
    const added = await addFirm(context(admin), {
      firm: { name: '', website: 'not a site', timeZone: 'Nowhere/Here' },
      contact: { fullName: '', email: 'nobody@@example', phone: '12' },
    });
    expect(added.ok).toBe(false);
    if (added.ok) return;
    expect(added.reason).toBe('firm_name_missing');
    expect(added.issues?.map(issue => `${issue.column}:${issue.code}`).sort()).toEqual([
      'contact_email:email_invalid',
      'contact_name:contact_name_missing',
      'contact_phone:phone_invalid',
      'firm_name:firm_name_missing',
      'time_zone:time_zone_invalid',
      'website:website_invalid',
    ]);
    expect(await count('firms')).toBe(before);
  });

  it('refuses a firm that is already here, naming it, rather than adding to it', async () => {
    const added = await addFirm(context(admin), {
      firm: { name: 'Anything', website: 'https://www.northwind.example.test' },
      contact: { fullName: 'New Person' },
    });
    expect(added).toMatchObject({
      ok: false,
      reason: 'duplicate_in_workspace',
      column: 'website',
      firmId: crm.alpha.firmId,
      issues: [{ column: 'website', code: 'duplicate_in_workspace' }],
    });
  });

  it('never matches a firm in the workspace next door', async () => {
    const other = workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.admin.userId, role: 'admin' });
    const added = await addFirm(context(other), { firm: { name: 'Aspen Test Wealth', website: 'aspen.example.test' } });
    expect(added.ok).toBe(true);
  });

  async function count(table: string): Promise<number> {
    const { rows } = await session.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table} WHERE workspace_id = $1`, [
      seeded.alpha.workspaceId,
    ]);
    return Number(rows[0]?.count ?? '0');
  }
});
