import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { MIGRATION_IDENTITY_COMMANDS, main } from '../src/tools/fss.ts';
import { parseFssCommand } from '../src/tools/fss/commands.ts';

/**
 * Migration 0018 through the tool the release runs it with (lane A4).
 *
 * `fss admin schema-preflight 0018` is what `infra/scripts/schema-preflight-0018.sh`
 * launches on the operations task before the stop; `fss migrate` refuses with the
 * counts when LinkedIn history would be erased, and `--remove-linkedin-history` is the
 * owner's decision to erase it. Each is run through `main`, as the task runs it,
 * against a real schema-17 database holding one LinkedIn step.
 *
 * ## The vacuous-pass trap
 *
 * A migrate that succeeded because there was nothing to refuse would pass the second
 * case. So the preflight runs first and must name the step it will refuse on.
 */

let database: TestDatabase;

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
  database = await createTestDatabase({ throughVersion: 17 });
  const one = async (sql: string, values: readonly unknown[]): Promise<string> => {
    const { rows } = await database.session.query<{ id: string }>(sql, values);
    return rows[0]?.id ?? '';
  };
  const workspaceId = await one("INSERT INTO workspaces (slug, display_name) VALUES ('preflight', 'Preflight') RETURNING id", []);
  const userId = await one(
    "INSERT INTO users (google_sub, email, display_name) VALUES ('preflight-sub', 'preflight@example.test', 'Preflight') RETURNING id",
    [],
  );
  await database.session.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [
    workspaceId,
    userId,
  ]);
  const sequenceId = await one(
    "INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, 'LinkedIn first', $2) RETURNING id",
    [workspaceId, userId],
  );
  const versionId = await one('INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id', [
    workspaceId,
    sequenceId,
  ]);
  await database.session.query(
    `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, linkedin_message)
     VALUES ($1, $2, 1, 'linkedin_task', 'elapsed', 0, 'Hello — a note from before.')`,
    [workspaceId, versionId],
  );
});

afterAll(async () => {
  await database.drop();
});

describe('fss and migration 0018', () => {
  it('parses the preflight on the runtime identity, and the switch on migrate', () => {
    expect(parseFssCommand(['admin', 'schema-preflight', '0018', '--report', '/tmp/x.json'])).toMatchObject({ ok: true });
    expect(parseFssCommand(['admin', 'schema-preflight', '0017'])).toMatchObject({ ok: false, reason: 'command_unknown' });
    expect(parseFssCommand(['migrate', '--report', '/tmp/m.json', '--remove-linkedin-history'])).toMatchObject({ ok: true });
    // The preflight reads with the application's credential, on the operations task.
    expect(MIGRATION_IDENTITY_COMMANDS).not.toContain('admin schema-preflight 0018');
  });

  it('counts on schema 17 and says 0018 would refuse', async () => {
    const { code, stdout } = await run(['admin', 'schema-preflight', '0018']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      applicable: true,
      schemaVersion: 17,
      migration: 18,
      refusesWithoutSetting: true,
      counts: { stepMessages: 1, linkedInSteps: 1, recordedLinkedInResults: 0, contactUrls: 0, versionsWithLinkedInReply: 1 },
    });
  });

  it('refuses the migration with the counts, exit 20, and leaves schema 17', async () => {
    const { code, stderr } = await run(['migrate']);
    expect(code).toBe(20);
    expect(stderr).toContain('linkedin_history_present');
    expect(stderr).toContain('0018 refused: linkedin_message=1 linkedin_results=0 unfit_urls=0');
    const { rows } = await database.session.query<{ version: number }>('SELECT max(version) AS version FROM schema_versions');
    expect(rows[0]?.version).toBe(17);
  });

  it('applies with --remove-linkedin-history, says so, and does not leave the setting behind', async () => {
    const { code, stdout } = await run(['migrate', '--remove-linkedin-history']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report).toMatchObject({ schemaVersionBefore: 17, schemaVersionAfter: 18, removeLinkedInHistory: true });
    expect(report['applied']).toEqual([{ version: 18, name: 'remove_linkedin' }]);

    // After 0018 there is nothing to decide, and the preflight says why.
    const after = await run(['admin', 'schema-preflight', '0018']);
    expect(after.code).toBe(20);
    expect(after.stderr).toContain('schema_not_17');
  });
});
