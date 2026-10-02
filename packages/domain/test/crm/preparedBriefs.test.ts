import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { readFirmPage } from '../../crm/firmPage.ts';
import { mergeFirms } from '../../crm/merges.ts';
import {
  importPreparedBriefs,
  matchPreparedBriefRows,
  readPreparedBrief,
} from '../../crm/preparedBriefs.ts';
import { commitDeletion, previewDeletion } from '../../retention/deletion.ts';
import { TABLE_RETENTION_COVERAGE } from '../../retention/coverage.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';

/**
 * A firm's prepared brief (lane PB, migration 0038): who may write it, what a write keeps,
 * what the audit row says (never the text), and what happens to it at a merge and a
 * deletion.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;

const as = (role: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: role === 'admin' ? seeded.alpha.admin.userId : seeded.alpha.salesperson.userId,
      role,
    }),
    database.session,
  );

const SECRET_TEXT = 'Who to ask for: Pat Placeholder, Owner (confirmed)\nBrief: ask about after-hours calls.';
const FULL = {
  brief: SECRET_TEXT,
  sources: [
    { url: 'https://firm.example.test/contact', label: 'Phone source' },
    { url: 'https://firm.example.test/about', label: 'Decision-maker' },
  ],
  observedOn: '2026-10-02',
  preparedBy: 'Callie research agent (web), verified phones',
};

async function newFirm(name: string, assignee: 'admin' | 'salesperson' = 'salesperson', website: string | null = null): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, website, time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, $4, 'America/Chicago', 'medium', 'state_default', 'firm-zone.1') RETURNING id`,
    [seeded.alpha.workspaceId, name, assignee === 'admin' ? seeded.alpha.admin.userId : seeded.alpha.salesperson.userId, website],
  );
  return rows[0]?.id ?? '';
}

const inTransaction = async <T>(work: () => Promise<T>): Promise<T> => await withTransaction(database.session, work);

/** A stored brief, written as an import writes it (briefs are read-only in Callie otherwise). */
async function seedBrief(firmId: string, brief: string = FULL.brief): Promise<void> {
  await database.session.query(
    `INSERT INTO firm_prepared_briefs (workspace_id, firm_id, brief, sources, observed_on, prepared_by, updated_by_user_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::date, $6, $7)
     ON CONFLICT ON CONSTRAINT firm_prepared_briefs_pkey DO UPDATE SET brief = EXCLUDED.brief`,
    [seeded.alpha.workspaceId, firmId, brief, JSON.stringify(FULL.sources), FULL.observedOn, FULL.preparedBy, seeded.alpha.admin.userId],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

describe('the firm page read', () => {
  it('adds the prepared brief only when it was negotiated, and null for a firm with none', async () => {
    const firmId = await newFirm('Prepared Page Test Co');
    const without = await readFirmPage(as('admin'), { firmId });
    expect(without.ok && 'preparedBrief' in without.value).toBe(false);
    const empty = await readFirmPage(as('admin'), { firmId, includePreparedBrief: true });
    expect(empty.ok && empty.value.visibility === 'assigned_or_admin' && empty.value.preparedBrief).toBeNull();
    await seedBrief(firmId);
    const withBrief = await readFirmPage(as('admin'), { firmId, includePreparedBrief: true });
    expect(withBrief.ok && withBrief.value.visibility === 'assigned_or_admin' && withBrief.value.preparedBrief?.brief).toBe(SECRET_TEXT);
  });

  it('never shows a colleague the brief: the narrow read has no key for it', async () => {
    const firmId = await newFirm('Prepared Colleague Test Co', 'admin');
    await seedBrief(firmId);
    const page = await readFirmPage(as('salesperson'), { firmId, includePreparedBrief: true });
    expect(page).toMatchObject({ ok: true, value: { visibility: 'any_active_member' } });
    expect(JSON.stringify(page)).not.toContain('Pat Placeholder');
  });
});

describe('matchPreparedBriefRows', () => {
  it('is an administrator’s read', async () => {
    expect(await matchPreparedBriefRows(as('salesperson'), { rows: [{ externalId: 'x' }] })).toEqual({ ok: false, reason: 'admin_only' });
  });

  it('matches by name when nothing else is given, and calls two firms of one name ambiguous', async () => {
    const single = await newFirm('Prepared Unique Name Test Co');
    await newFirm('Prepared Twin Name Test Co');
    await newFirm('Prepared Twin Name Test Co');
    const matched = await matchPreparedBriefRows(as('admin'), {
      rows: [{ firmName: 'prepared unique name test co' }, { firmName: 'Prepared Twin Name Test Co' }, { firmName: 'Nobody Test Co' }],
    });
    expect(matched).toEqual({
      ok: true,
      value: [
        { status: 'matched', firmId: single, firmName: 'Prepared Unique Name Test Co', matchedOn: 'name' },
        { status: 'ambiguous', column: 'firm_name' },
        { status: 'unmatched' },
      ],
    });
  });
});

describe('a merge', () => {
  const merge = async (sourceFirmId: string, targetFirmId: string): Promise<void> => {
    const merged = await inTransaction(
      async () => await mergeFirms(as('admin'), { sourceFirmId, targetFirmId, resolutions: { name: 'target' } }),
    );
    expect(merged, JSON.stringify(merged)).toMatchObject({ ok: true });
  };

  it('keeps the surviving firm’s own brief and drops the merged firm’s', async () => {
    const source = await newFirm('Prepared Merge Source A Test Co');
    const target = await newFirm('Prepared Merge Target A Test Co');
    await seedBrief(source, 'Source brief');
    await seedBrief(target, 'Target brief');
    await merge(source, target);
    expect((await readPreparedBrief(as('admin'), target))?.brief).toBe('Target brief');
    expect(await readPreparedBrief(as('admin'), source)).toBeNull();
  });

  it('gives the surviving firm the merged firm’s brief when it has none', async () => {
    const source = await newFirm('Prepared Merge Source B Test Co');
    const target = await newFirm('Prepared Merge Target B Test Co');
    await seedBrief(source, 'Source brief');
    await merge(source, target);
    expect((await readPreparedBrief(as('admin'), target))?.brief).toBe('Source brief');
    expect(await readPreparedBrief(as('admin'), source)).toBeNull();
  });
});

describe('the deletion workflow', () => {
  it('names the table in the registry as removed with the firm', () => {
    expect(TABLE_RETENTION_COVERAGE['firm_prepared_briefs']?.dispositions).toEqual(['deletion_removes']);
  });

  it('removes the brief with the firm, and leaves it when one contact is deleted', async () => {
    await seedBrief(crm.alpha.firmId);
    const contactPreview = await previewDeletion(as('admin'), {
      targetKind: 'contact',
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    });
    expect(contactPreview.value?.removes['firm_prepared_briefs']).toBe(0);

    const preview = await previewDeletion(as('admin'), { targetKind: 'firm', firmId: crm.alpha.firmId });
    expect(preview.value?.removes['firm_prepared_briefs']).toBe(1);
    const outcome = await commitDeletion(as('admin'), {
      requestId: preview.value?.requestId ?? '',
      previewHash: preview.value?.previewHash ?? '',
      commandId: 'deletion-prepared-brief-firm',
      journal: recordingSuppressionJournal(),
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
    expect(await readPreparedBrief(as('admin'), crm.alpha.firmId)).toBeNull();
  });
});

describe('importPreparedBriefs (design reset I1)', () => {
  const fileRow = (fields: { readonly website?: string; readonly firm_name?: string; readonly external_id?: string; readonly brief?: string }) => ({
    brief: SECRET_TEXT,
    sources: [{ url: 'https://firm.example.test/contact', label: 'Phone source' }],
    observed_on: '2026-10-02',
    prepared_by: 'Callie research agent (web), verified phones',
    ...fields,
  });

  it('is an administrator’s command', async () => {
    expect(await inTransaction(async () => await importPreparedBriefs(as('salesperson'), { rows: [fileRow({ firm_name: 'Anything' })] }))).toEqual({
      ok: false,
      reason: 'admin_only',
    });
  });

  it('matches exactly as /firms/brief/match does, writes the matched rows, skips the rest with a reason, and audits counts only', async () => {
    const one = await newFirm('Import Parity One Test Co', 'salesperson', 'https://parity-one.example.test');
    const two = await newFirm('Import Parity Two Test Co', 'salesperson', 'https://parity-two.example.test');
    await newFirm('Import Twin Test Co');
    await newFirm('Import Twin Test Co');
    const rows = [
      fileRow({ website: 'https://www.parity-one.example.test/about' }),
      fileRow({ firm_name: 'import parity two test co', brief: 'Two brief' }),
      fileRow({ firm_name: 'Import Twin Test Co' }),
      fileRow({ external_id: 'dfw-nobody' }),
    ];
    const match = await matchPreparedBriefRows(as('admin'), {
      rows: rows.map(row => ({
        ...(row.website === undefined ? {} : { website: row.website }),
        ...(row.firm_name === undefined ? {} : { firmName: row.firm_name }),
        ...(row.external_id === undefined ? {} : { externalId: row.external_id }),
      })),
    });
    const imported = await inTransaction(async () => await importPreparedBriefs(as('admin'), { rows }));
    expect(imported).toEqual({
      ok: true,
      value: {
        rows: [
          { index: 1, status: 'saved', firmId: one },
          { index: 2, status: 'saved', firmId: two },
          { index: 3, status: 'ambiguous', column: 'firm_name' },
          { index: 4, status: 'unmatched' },
        ],
        counts: { saved: 2, unchanged: 0, unmatched: 1, ambiguous: 1 },
      },
    });
    // Parity: the same firm, the same status, row by row.
    if (!match.ok || !imported.ok) throw new Error('refused');
    expect(imported.value.rows.map(row => (row.status === 'saved' ? 'matched' : row.status))).toEqual(match.value.map(row => row.status));
    expect(imported.value.rows.map(row => row.firmId ?? null)).toEqual(match.value.map(row => (row.status === 'matched' ? row.firmId : null)));
    expect((await readPreparedBrief(as('admin'), two))?.brief).toBe('Two brief');

    const { rows: audits } = await database.session.query<{ detail: unknown }>(
      `SELECT detail FROM audit_events WHERE workspace_id = $1 AND action = 'firm.prepared_briefs_imported'`,
      [seeded.alpha.workspaceId],
    );
    expect(audits.map(row => row.detail)).toEqual([{ rows: 4, saved: 2, unchanged: 0, unmatched: 1, ambiguous: 1 }]);
    expect(JSON.stringify(audits)).not.toContain('Pat Placeholder');

    // The same file again changes nothing and says so.
    const again = await inTransaction(async () => await importPreparedBriefs(as('admin'), { rows: rows.slice(0, 2) }));
    expect(again.ok && again.value.counts).toEqual({ saved: 0, unchanged: 2, unmatched: 0, ambiguous: 0 });
  });

  it('replaces a matched firm’s brief whole: text, sources, date and preparer (the only change path)', async () => {
    const firmId = await newFirm('Import Replace Test Co', 'salesperson', 'https://replace.example.test');
    await seedBrief(firmId, 'Old text');
    const imported = await inTransaction(
      async () =>
        await importPreparedBriefs(as('admin'), {
          rows: [
            {
              website: 'https://replace.example.test',
              brief: 'Corrected text',
              sources: [{ url: 'https://replace.example.test/new', label: 'Corrected source' }],
              observed_on: '2026-10-03',
              prepared_by: 'Corrected preparer',
            },
          ],
        }),
    );
    expect(imported.ok && imported.value.rows).toEqual([{ index: 1, status: 'saved', firmId }]);
    expect(await readPreparedBrief(as('admin'), firmId)).toMatchObject({
      brief: 'Corrected text',
      sources: [{ url: 'https://replace.example.test/new', label: 'Corrected source' }],
      observedOn: '2026-10-03',
      preparedBy: 'Corrected preparer',
    });
  });

  it('writes nothing at all when a database failure stops row 2', async () => {
    const first = await newFirm('Import Atomic One Test Co', 'salesperson', 'https://atomic-one.example.test');
    const second = await newFirm('Import Atomic Two Test Co', 'salesperson', 'https://atomic-two.example.test');
    await database.session.query(`
      CREATE FUNCTION refuse_second_import() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.brief = 'FAIL HERE' THEN RAISE EXCEPTION 'forced failure on row 2'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_second_import BEFORE INSERT OR UPDATE ON firm_prepared_briefs
        FOR EACH ROW EXECUTE FUNCTION refuse_second_import();`);
    const importAudits = async (): Promise<number> =>
      Number(
        (await database.session.query<{ n: string }>(`SELECT count(*) AS n FROM audit_events WHERE workspace_id = $1 AND action = 'firm.prepared_briefs_imported'`, [seeded.alpha.workspaceId]))
          .rows[0]?.n,
      );
    const auditsBefore = await importAudits();
    try {
      await expect(
        inTransaction(
          async () =>
            await importPreparedBriefs(as('admin'), {
              rows: [fileRow({ website: 'https://atomic-one.example.test' }), fileRow({ website: 'https://atomic-two.example.test', brief: 'FAIL HERE' })],
            }),
        ),
      ).rejects.toThrow('forced failure on row 2');
      expect(await readPreparedBrief(as('admin'), first)).toBeNull();
      expect(await readPreparedBrief(as('admin'), second)).toBeNull();
      expect(await importAudits()).toBe(auditsBefore);
    } finally {
      await database.session.query('DROP TRIGGER refuse_second_import ON firm_prepared_briefs; DROP FUNCTION refuse_second_import();');
    }
  });
});
