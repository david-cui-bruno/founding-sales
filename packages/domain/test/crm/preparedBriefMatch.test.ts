import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type WorkspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { IMPORT_COLUMNS } from '@fss/contracts';
import {
  commitImportRow,
  matchExisting,
  previewCsvImport,
  workspaceIndex,
  type ImportFirmDraft,
} from '../../crm/import.ts';

/**
 * Contract check for lane PB: a prepared-brief JSON row finds the firm a CSV import made by
 * its external id, using the importer's own matcher (`workspaceIndex` + `matchExisting`),
 * not a copy of it. Thirty firms are imported exactly as the DFW batch was.
 */
describe('prepared briefs reuse the CSV importer matcher', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let admin: WorkspaceScope;
  const firmIds = new Map<string, string>();

  const externalId = (n: number): string => `dfw-20261002-${n % 2 === 0 ? 'w' : 'e'}${String(n).padStart(2, '0')}`;

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    admin = workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' });
    const header = IMPORT_COLUMNS.join(',');
    const lines = Array.from({ length: 30 }, (_, i) => {
      const n = i + 1;
      return `Contract Test Firm ${String(n)},https://firm${String(n)}.example.test,,Dallas,TX,75201,${externalId(n)},,,,,,America/Chicago`;
    });
    const context = repositoryContext(admin, session);
    const preview = await previewCsvImport(context, { csv: [header, ...lines].join('\n') });
    if (!preview.ok) throw new Error(preview.reason);
    for (const row of preview.value.rows) {
      const committed = await commitImportRow(context, row);
      if (!committed.ok) throw new Error(committed.reason);
      firmIds.set(row.firm.externalId ?? '', committed.value.firmId);
    }
  });

  afterAll(async () => {
    await database.drop();
  });

  const draft = (fields: Partial<ImportFirmDraft>): ImportFirmDraft => ({
    name: '',
    website: null,
    addressLine: null,
    locality: null,
    regionCode: null,
    postalCode: null,
    externalId: null,
    ownerUserId: null,
    timeZone: null,
    ...fields,
  });

  it('matches all thirty imported firms by external id alone', async () => {
    expect(firmIds.size).toBe(30);
    const index = await workspaceIndex(repositoryContext(admin, session));
    for (let n = 1; n <= 30; n += 1) {
      const matched = matchExisting(index, draft({ externalId: externalId(n) }));
      expect(matched).toEqual({
        kind: 'match',
        match: { kind: 'existing', firmId: firmIds.get(externalId(n)), firmName: `Contract Test Firm ${String(n)}`, matchedOn: 'external_id' },
      });
    }
  });

  it('falls back to the domain, reports none for an unknown id, and ambiguous for two firms', async () => {
    const context = repositoryContext(admin, session);
    // A second firm on firm1's domain under another name makes the domain ambiguous.
    await session.query(
      `INSERT INTO firms (workspace_id, name, website, time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
       VALUES ($1, 'Contract Twin', 'https://www.firm1.example.test', 'America/Chicago', 'medium', 'state_default', 'firm-zone.1')`,
      [seeded.alpha.workspaceId],
    );
    const index = await workspaceIndex(context);
    expect(matchExisting(index, draft({ website: 'https://firm2.example.test/about' }))).toMatchObject({
      kind: 'match',
      match: { firmId: firmIds.get(externalId(2)), matchedOn: 'domain' },
    });
    expect(matchExisting(index, draft({ externalId: 'dfw-20261002-x99' }))).toEqual({ kind: 'none' });
    expect(matchExisting(index, draft({ website: 'firm1.example.test' }))).toEqual({ kind: 'ambiguous', column: 'website' });
    // The external id still wins over an ambiguous domain.
    expect(matchExisting(index, draft({ externalId: externalId(1), website: 'firm1.example.test' }))).toMatchObject({
      kind: 'match',
      match: { firmId: firmIds.get(externalId(1)), matchedOn: 'external_id' },
    });
  });
});
