import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { MIGRATION_IDENTITY_COMMANDS, main } from '../src/tools/fss.ts';
import { parseFssCommand } from '../src/tools/fss/commands.ts';

/**
 * Migration 0019 through the tool the release runs it with (lane W2-M).
 *
 * `fss admin schema-preflight 0019` is what `infra/scripts/schema-preflight-0019.sh`
 * launches on the operations task before the stop; `fss migrate` refuses (FS019, exit
 * 20) while a value 0019 drops is stored, and applies once it is not. Each is run through
 * `main`, as the task runs it, against a real schema-18 database.
 *
 * ## The vacuous-pass trap
 *
 * A migrate that succeeded because there was nothing to refuse would prove nothing, so
 * the database holds one LinkedIn step and one research page (research's data, not its
 * seeded configuration), the preflight must count both and say 0019 refuses, and the
 * migrate must refuse with the same counts before they are removed.
 */

let database: TestDatabase;
let workspaceId = '';
let userId = '';

/** The test database's own URL, from the session's connection. */
async function databaseUrl(): Promise<string> {
  const { rows } = await database.session.query<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  url.pathname = `/${rows[0]?.name ?? ''}`;
  return url.toString();
}

async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const url = await databaseUrl();
  const printed: string[] = [];
  const logged: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    logged.push(String(chunk));
    return true;
  });
  try {
    const code = await main(argv, { DATABASE_URL: url, FSS_MIGRATION_DATABASE_URL: url });
    return { code, stdout: printed.join(''), stderr: logged.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

beforeAll(async () => {
  database = await createTestDatabase({ throughVersion: 18 });
  const one = async (sql: string, values: readonly unknown[]): Promise<string> => {
    const { rows } = await database.session.query<{ id: string }>(sql, values);
    return rows[0]?.id ?? '';
  };
  // The workspace insert fires 0007's trigger, which seeds research's configuration.
  workspaceId = await one("INSERT INTO workspaces (slug, display_name) VALUES ('preflight', 'Preflight') RETURNING id", []);
  userId = await one(
    "INSERT INTO users (google_sub, email, display_name) VALUES ('preflight-sub', 'preflight@example.test', 'Preflight') RETURNING id",
    [],
  );
  await database.session.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [
    workspaceId,
    userId,
  ]);
  await database.session.query(
    `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
     VALUES ($1, 'client_version_range', 1, '{"minimum": "1.0.0", "maximum": "1.4.0"}'::jsonb, 'old', $2)`,
    [workspaceId, userId],
  );
  const sequenceId = await one(
    "INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, 'LinkedIn first', $2) RETURNING id",
    [workspaceId, userId],
  );
  const versionId = await one('INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id', [
    workspaceId,
    sequenceId,
  ]);
  await database.session.query(
    `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount)
     VALUES ($1, $2, 1, 'linkedin_task', 'elapsed', 0)`,
    [workspaceId, versionId],
  );
  await database.session.query(
    `INSERT INTO research_pages (workspace_id, provider_key, query_hash, page_hash, query_text)
     VALUES ($1, 'places', repeat('a', 64), repeat('b', 64), 'accountants in Providence')`,
    [workspaceId],
  );
});

afterAll(async () => {
  await database.drop();
});

describe('fss and migration 0019', () => {
  it('parses the preflight, which runs on the runtime identity', () => {
    expect(parseFssCommand(['admin', 'schema-preflight', '0019', '--report', '/tmp/x.json'])).toMatchObject({ ok: true });
    expect(parseFssCommand(['admin', 'schema-preflight', '0018'])).toMatchObject({ ok: false, reason: 'command_unknown' });
    expect(MIGRATION_IDENTITY_COMMANDS).not.toContain('admin schema-preflight 0019');
  });

  it('counts on schema 18 and says 0019 would refuse', async () => {
    const { code, stdout } = await run(['admin', 'schema-preflight', '0019']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      applicable: true,
      schemaVersion: 18,
      migration: 19,
      refuses: true,
      counts: {
        blocking: {
          linkedInSteps: 1,
          linkedInExecutions: 0,
          enrollmentMigrations: 0,
          researchPages: 1,
          researchSuggestions: 0,
          researchProviderLedger: 0,
        },
        // The seeded configuration is counted apart from the data, and never blocks.
        destroyed: {
          researchSeed: { research_settings: 1, research_providers: 3, research_route_policies: 1 },
          clientVersionRangeRows: 1,
        },
        archivedMergeEvents: 0,
        reviewRequiredEnrollments: 0,
      },
    });
  });

  it('refuses the migration with the same count, exit 20, and leaves schema 18', async () => {
    const { code, stderr } = await run(['migrate']);
    expect(code).toBe(20);
    expect(stderr).toContain('migration_refused');
    // Non-zero counts only, so the whole message fits the 200 characters a logged value keeps.
    expect(stderr).toContain('"detail":"FS019: 0019 refused: research_pages=1 linkedin_steps=1"');
    const { rows } = await database.session.query<{ version: number }>('SELECT max(version) AS version FROM schema_versions');
    expect(rows[0]?.version).toBe(18);
  });

  it('applies once nothing it refuses on is stored, and then has nothing to count', async () => {
    await database.session.query("DELETE FROM sequence_steps WHERE channel = 'linkedin_task'");
    expect(JSON.parse((await run(['admin', 'schema-preflight', '0019'])).stdout)).toMatchObject({ refuses: true });
    await database.session.query('DELETE FROM research_pages');
    const preflight = JSON.parse((await run(['admin', 'schema-preflight', '0019'])).stdout) as Record<string, unknown>;
    expect(preflight['refuses']).toBe(false);

    const { code, stdout } = await run(['migrate']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report).toMatchObject({ schemaVersionBefore: 18, schemaVersionAfter: 19 });
    expect(report['applied']).toEqual([{ version: 19, name: 'wave2_cleanup' }]);

    const after = await run(['admin', 'schema-preflight', '0019']);
    expect(after.code).toBe(20);
    expect(after.stderr).toContain('schema_not_18');
  });
});
