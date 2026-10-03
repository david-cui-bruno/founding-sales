import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { main } from '../src/tools/fss.ts';
import { COMMAND_DEPENDENCIES, parseFssCommand } from '../src/tools/fss/commands.ts';

/**
 * `fss admin import-match report` on real PostgreSQL (lane PBM): whether a CSV import's firms
 * are in a workspace, as five counts. Synthetic throughout (`syn-` external ids, `example.test`).
 *
 * The fixture in alpha: two active firms and one merged firm carrying a `syn-0001-` external
 * id, one active firm with another prefix, and one active firm created a month ago. In beta, a
 * firm with a `syn-0001-` id that must not be counted. Every expected number differs, so a
 * count read from the wrong column or the wrong workspace fails.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let url = '';
/** What the shared fixture seeded in alpha before this file's firms: active, and created this week. */
let seededActive = 0;
let seededRecent = 0;

async function one(sql: string, values: readonly unknown[] = []): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(sql, values);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the fixture returned no row: ${sql.slice(0, 60)}`);
  return id;
}

async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const printed: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return { code: await main(argv, { DATABASE_URL: url }), stdout: printed.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

const firm = async (workspaceId: string, name: string, externalId: string | null): Promise<string> => {
  const id = await one('INSERT INTO firms (workspace_id, name, website) VALUES ($1, $2, $3) RETURNING id', [
    workspaceId,
    name,
    `https://${name.toLowerCase().replace(/[^a-z]/gu, '')}.example.test/`,
  ]);
  if (externalId !== null) {
    await database.session.query(
      "INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value) VALUES ($1, 'firm', $2, 'external_id', $3)",
      [workspaceId, id, externalId],
    );
  }
  return id;
};

beforeAll(async () => {
  database = await createTestDatabase();
  const named = await database.session.query<{ name: string }>('SELECT current_database() AS name');
  const clusterUrl = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  clusterUrl.pathname = `/${named.rows[0]?.name ?? ''}`;
  url = clusterUrl.toString();
  seeded = await seedTwoWorkspaces(database.session);
  const alpha = seeded.alpha.workspaceId;
  const seededCounts = await database.session.query<{ active: string; recent: string }>(
    `SELECT count(*) FILTER (WHERE status = 'active')::text AS active,
            count(*) FILTER (WHERE created_at > now() - interval '7 days')::text AS recent
       FROM firms WHERE workspace_id = $1`,
    [alpha],
  );
  seededActive = Number(seededCounts.rows[0]?.active);
  seededRecent = Number(seededCounts.rows[0]?.recent);
  await firm(alpha, 'Synthetic One Test Co', 'syn-0001-e01');
  const survivor = await firm(alpha, 'Synthetic Two Test Co', 'syn-0001-e02');
  const loser = await firm(alpha, 'Synthetic Three Test Co', 'syn-0001-e03');
  await database.session.query("UPDATE firms SET status = 'merged', merged_into_firm_id = $3 WHERE workspace_id = $1 AND id = $2", [alpha, loser, survivor]);
  await firm(alpha, 'Synthetic Other Test Co', 'other-0001-e01');
  const old = await firm(alpha, 'Synthetic Old Test Co', null);
  await database.session.query(
    "UPDATE firms SET created_at = now() - interval '30 days', updated_at = now() - interval '30 days' WHERE workspace_id = $1 AND id = $2",
    [alpha, old],
  );
  await firm(seeded.beta.workspaceId, 'Synthetic Beta Test Co', 'syn-0001-b01');
});

afterAll(async () => {
  await database.drop();
});

describe('fss admin import-match report', () => {
  it('is a parseable database-only command that needs both flags', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(parseFssCommand(['admin', 'import-match', 'report', '--workspace-id', id, '--external-id-prefix', 'syn-0001'])).toMatchObject({ ok: true });
    expect(parseFssCommand(['admin', 'import-match', 'report', '--workspace-id', id])).toMatchObject({ ok: false });
    expect(parseFssCommand(['admin', 'import-match', 'report', '--external-id-prefix', 'syn-0001'])).toMatchObject({ ok: false });
    expect(COMMAND_DEPENDENCIES['import-match report']).toBe('database');
  });

  it('prints one line of five counts, for the named workspace and prefix only, and nothing that names a firm', async () => {
    const alpha = seeded.alpha.workspaceId;
    const before = await database.session.query<{ count: string }>('SELECT count(*)::text AS count FROM record_aliases');
    const { code, stdout } = await run(['admin', 'import-match', 'report', '--workspace-id', alpha, '--external-id-prefix', 'syn-0001']);
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(report).toEqual({
      // Four active of this file's (one is merged), four created this week (one is a month old).
      activeFirms: seededActive + 4,
      externalIdAliases: 3,
      aliasesOnActiveFirms: 2,
      aliasesOnMergedFirms: 1,
      firmsCreatedLast7Days: seededRecent + 4,
    });
    // Log hygiene: no id, alias value, name or website.
    for (const forbidden of [alpha, 'syn-0001-e01', 'Synthetic', 'example.test']) expect(stdout).not.toContain(forbidden);
    // Read only.
    const afterRows = await database.session.query<{ count: string }>('SELECT count(*)::text AS count FROM record_aliases');
    expect(afterRows.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('counts nothing for a workspace that has none of the prefix', async () => {
    const { code, stdout } = await run(['admin', 'import-match', 'report', '--workspace-id', seeded.beta.workspaceId, '--external-id-prefix', 'other-0001']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({ externalIdAliases: 0, aliasesOnActiveFirms: 0, aliasesOnMergedFirms: 0 });
  });

  it('refuses a prefix that is short, a pattern or upper case, a malformed id, and a workspace that does not exist', async () => {
    const alpha = seeded.alpha.workspaceId;
    for (const prefix of ['syn', 'syn%', 'syn_0001', 'SYN-0001', '', 'syn 0001']) {
      const { code, stdout } = await run(['admin', 'import-match', 'report', '--workspace-id', alpha, '--external-id-prefix', prefix]);
      expect(code, prefix).not.toBe(0);
      expect(stdout).toBe('');
    }
    expect((await run(['admin', 'import-match', 'report', '--workspace-id', 'not-a-uuid', '--external-id-prefix', 'syn-0001'])).code).not.toBe(0);
    expect((await run(['admin', 'import-match', 'report', '--workspace-id', '00000000-0000-4000-8000-000000000000', '--external-id-prefix', 'syn-0001'])).code).not.toBe(0);
  });
});
