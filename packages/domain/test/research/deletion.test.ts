import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { commitDeletion, previewDeletion } from '../../retention/deletion.ts';
import { TABLE_RETENTION_COVERAGE } from '../../retention/coverage.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';

/**
 * A firm deletion takes its research with it (specification 10.3).
 *
 * The four research tables quote the firm's own pages or name a person at it, so they
 * go with the firm exactly as `call_logs` does. What makes this worth its own test
 * rather than a line in the coverage registry is the **order**: `firm_facts`
 * references both `research_runs` and `evidence_items`, and `evidence_items` is
 * already removed by this workflow. A statement in the wrong place is a foreign-key
 * violation on a command an admin has already approved.
 *
 * The contact-scoped half is the other half of the rule: a quote from a firm's
 * careers page is not one person's data, and a contact deletion leaves it.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;

const admin = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
    database.session,
  );

const count = async (table: string, firmId: string): Promise<number> => {
  const { rows } = await database.session.query<{ count: string }>(
    `SELECT count(*) AS count FROM ${table} WHERE workspace_id = $1 AND firm_id = $2`,
    [seeded.alpha.workspaceId, firmId],
  );
  return Number(rows[0]?.count ?? '0');
};

async function seedResearch(firmId: string): Promise<void> {
  const run = await database.session.query<{ id: string }>(
    `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome)
     VALUES ($1, $2, 1, 'sweep', now(), 'completed') RETURNING id`,
    [seeded.alpha.workspaceId, firmId],
  );
  const evidence = await database.session.query<{ id: string }>(
    `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash)
     VALUES ($1, $2, 'company_page', 'https://example.test/', $3) RETURNING id`,
    [seeded.alpha.workspaceId, firmId, 'd'.repeat(64)],
  );
  await database.session.query(
    `INSERT INTO firm_facts (workspace_id, firm_id, run_id, evidence_id, key, block_id, quote, retrieved_at)
     VALUES ($1, $2, $3, $4, 'target_fit', 'b1', 'We manage property for owners.', now())`,
    [seeded.alpha.workspaceId, firmId, run.rows[0]?.id, evidence.rows[0]?.id],
  );
  await database.session.query(
    `INSERT INTO firm_judgments (workspace_id, firm_id, run_id, fit, problem_evidence, timing, reachability, call_first)
     VALUES ($1, $2, $3, 'yes', 'unknown', 'unknown', 'yes', true)`,
    [seeded.alpha.workspaceId, firmId, run.rows[0]?.id],
  );
  await database.session.query(
    `INSERT INTO firm_links (workspace_id, firm_id, url, added_by_user_id)
     VALUES ($1, $2, 'https://news.example.test/piece', $3)`,
    [seeded.alpha.workspaceId, firmId, seeded.alpha.admin.userId],
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

describe('the deletion workflow and research', () => {
  it('names the research tables in the registry, so nothing here is a silent store', () => {
    for (const table of ['research_runs', 'firm_facts', 'firm_judgments', 'firm_links']) {
      expect(TABLE_RETENTION_COVERAGE[table]?.dispositions, table).toContain('deletion_removes');
    }
    for (const table of ['research_settings', 'provider_ledger']) {
      expect(TABLE_RETENTION_COVERAGE[table]?.dispositions, table).toEqual(['operational']);
    }
  });

  it('counts the research rows in the preview and removes them in foreign-key order', async () => {
    await seedResearch(crm.alpha.firmId);
    const context = admin();

    const preview = await previewDeletion(context, { targetKind: 'firm', firmId: crm.alpha.firmId });
    expect(preview.value?.removes['firm_facts']).toBe(1);
    expect(preview.value?.removes['firm_judgments']).toBe(1);
    expect(preview.value?.removes['research_runs']).toBe(1);
    expect(preview.value?.removes['firm_links']).toBe(1);

    const outcome = await commitDeletion(context, {
      requestId: preview.value?.requestId ?? '',
      previewHash: preview.value?.previewHash ?? '',
      commandId: 'deletion-research-firm',
      journal: recordingSuppressionJournal(),
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);

    for (const table of ['firm_facts', 'firm_judgments', 'research_runs', 'firm_links', 'evidence_items']) {
      expect(await count(table, crm.alpha.firmId), table).toBe(0);
    }
    expect(outcome.ok && outcome.value.removed['firm_facts']).toBe(1);
  });

  it('leaves the firm’s research alone when one contact is deleted', async () => {
    await seedResearch(crm.alpha.firmId);
    const context = admin();
    const preview = await previewDeletion(context, {
      targetKind: 'contact',
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    });
    expect(preview.value?.removes['firm_facts']).toBe(0);
    expect(preview.value?.removes['research_runs']).toBe(0);

    const outcome = await commitDeletion(context, {
      requestId: preview.value?.requestId ?? '',
      previewHash: preview.value?.previewHash ?? '',
      commandId: 'deletion-research-contact',
      journal: recordingSuppressionJournal(),
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
    // A quote from the firm's own careers page is not one person's data.
    expect(await count('firm_facts', crm.alpha.firmId)).toBe(1);
    expect(await count('research_runs', crm.alpha.firmId)).toBe(1);
  });

  it('keeps no quote naming a person, so a contact deletion has nothing left to miss', async () => {
    // The reason the person keys store no quote at all. A contact-scoped deletion does
    // not touch a firm's rows — the test above is the rule, and it is the right rule —
    // so a `named_role` quote reading a person's name and number would outlive the
    // contact it names, in a table nobody would think to search. The schema is what
    // makes that impossible: `firm_facts_person_keys_have_no_quote`.
    const run = await database.session.query<{ id: string }>(
      `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome)
       VALUES ($1, $2, 99, 'sweep', now(), 'completed') RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    const evidence = await database.session.query<{ id: string }>(
      `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash)
       VALUES ($1, $2, 'company_page', 'https://example.test/team', $3) RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, 'e'.repeat(64)],
    );
    // The insert a real run makes for these keys: the block is named, the text is not.
    for (const key of ['named_role', 'phone_listed', 'role']) {
      await database.session.query(
        `INSERT INTO firm_facts (workspace_id, firm_id, run_id, evidence_id, key, block_id, quote, retrieved_at)
         VALUES ($1, $2, $3, $4, $5, 'b1', NULL, now())`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, run.rows[0]?.id, evidence.rows[0]?.id, key],
      );
    }
    // And the schema refuses the other shape outright.
    await expect(
      database.session.query(
        `INSERT INTO firm_facts (workspace_id, firm_id, run_id, evidence_id, key, block_id, quote, retrieved_at)
         VALUES ($1, $2, $3, $4, 'named_role', 'b2', 'Dana Placeholder, Maintenance Coordinator', now())`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, run.rows[0]?.id, evidence.rows[0]?.id],
      ),
    ).rejects.toThrow(/firm_facts_person_keys_have_no_quote/u);

    // Every quote this workspace holds, searched for the name and the number a team
    // page would carry. There is nowhere for either to be.
    const quotes = await database.session.query<{ quote: string | null }>(
      'SELECT quote FROM firm_facts WHERE workspace_id = $1',
      [seeded.alpha.workspaceId],
    );
    const all = quotes.rows.map(row => row.quote ?? '').join('\n');
    expect(all).not.toContain('Dana Placeholder');
    expect(all).not.toContain('555-0100');
  });
});
