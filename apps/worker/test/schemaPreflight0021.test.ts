import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '@fss/domain/db/schemaRange.ts';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import {
  CLUSTER_URL_ENVIRONMENT_VARIABLE,
  createTestDatabase,
  type TestDatabase,
} from '@fss/domain/db/testing/testDatabase.ts';
import { MIGRATION_IDENTITY_COMMANDS, main } from '../src/tools/fss.ts';
import { parseFssCommand } from '../src/tools/fss/commands.ts';
import {
  readSchemaPreflight0021,
  SCHEMA_PREFLIGHT_0021_CLIENT_VERSIONS_SQL,
  SCHEMA_PREFLIGHT_0021_COUNTS_SQL,
  SCHEMA_PREFLIGHT_0021_REVIEW_REQUIRED_SQL,
} from '../src/tools/fss/schemaPreflight0021.ts';

/**
 * `fss admin schema-preflight 0021` on a real schema-20 database (lane W3-C2).
 *
 * The coordinator runs this through `infra/scripts/preflight.sh <root> <prefix> 0021`
 * while both services are still running. 0021 refuses on one thing — an enrollment still
 * in `review_required` — and destroys three sets of rows without asking, which the report
 * counts rather than blocks on.
 *
 * ## The vacuous-pass traps, named
 *
 * **A count over an empty database.** The fixture stores two devices, three
 * refresh-credential rows (one `active`, one `rotated`, one `revoked`), a device whose
 * generation has moved past the claim's 1, and the `system_generations` row migration
 * 0001 seeded, so every reported number below is non-zero because something is there.
 *
 * **A "report" that quietly blocks, or a blocker that never fires.** Nothing the fixture
 * stores makes `refuses` true: a spent credential is not a reason to stop a release. The
 * blocking path is exercised separately, over a session that answers a `review_required`
 * count, so the refusal and the named ids are asserted rather than assumed.
 *
 * **SQL that is only ever run against a stub.** The three statements the stub answers are
 * the exported constants, and the real-database test above runs every one of them through
 * `readSchemaPreflight0021` on a schema-20 database. So a column that does not exist
 * fails here rather than on the operations task.
 *
 * **A report read on the wrong schema.** On schema 21 — after the migration — and on
 * anything below 20, the command refuses with `schema_not_20` and exit 20.
 */

let database: TestDatabase;
let workspaceId = '';
let userId = '';
let firstDeviceId = '';
let secondDeviceId = '';

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

async function one(sql: string, values: readonly unknown[]): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(sql, values);
  return rows[0]?.id ?? '';
}

const digest = (seed: string): string => seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/gu, 'a');

beforeAll(async () => {
  database = await createTestDatabase({ throughVersion: 20 });
  workspaceId = await one("INSERT INTO workspaces (slug, display_name) VALUES ('preflight21', 'Preflight') RETURNING id", []);
  userId = await one(
    "INSERT INTO users (google_sub, email, display_name) VALUES ('preflight21-sub', 'preflight21@example.test', 'Preflight') RETURNING id",
    [],
  );
  await database.session.query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
    [workspaceId, userId],
  );

  // A Mac that renewed twice — so its generation has moved past the claim's 1 — and a
  // Mac that has not. `client_version` is what each last told the server.
  firstDeviceId = await one(
    `INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, credential_generation, client_version)
     VALUES ($1, $2, 'Rotated Mac', $3, 3, '1.0.13') RETURNING id`,
    [workspaceId, userId, digest('device1')],
  );
  secondDeviceId = await one(
    `INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, client_version)
     VALUES ($1, $2, 'Opening Mac', $3, '1.0.14') RETURNING id`,
    [workspaceId, userId, digest('device2')],
  );

  // Three credential rows over the two devices: one live, two spent or taken away.
  await database.session.query(
    `INSERT INTO device_refresh_credentials (workspace_id, device_id, generation, secret_hash, state, expires_at, used_at)
     VALUES ($1, $2, 1, $4, 'rotated', now() + interval '30 days', now()),
            ($1, $2, 2, $5, 'revoked', now() + interval '30 days', NULL),
            ($1, $3, 1, $6, 'active',  now() + interval '30 days', NULL)`,
    [workspaceId, firstDeviceId, secondDeviceId, digest('cred1'), digest('cred2'), digest('cred3')],
  );
});

afterAll(async () => {
  await database.drop();
});

describe('fss and migration 0021', () => {
  it('parses the preflight, which runs on the runtime identity', () => {
    expect(parseFssCommand(['admin', 'schema-preflight', '0021', '--report', '/tmp/x.json'])).toMatchObject({ ok: true });
    expect(MIGRATION_IDENTITY_COMMANDS).not.toContain('admin schema-preflight 0021');
  });

  it('reports what 0021 destroys on schema 20, refuses on nothing, and says the check it cannot make', async () => {
    const { code, stdout } = await run(['admin', 'schema-preflight', '0021']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      applicable: true,
      schemaVersion: 20,
      migration: 21,
      refuses: false,
      counts: {
        blocking: { reviewRequiredEnrollments: 0 },
        reviewRequired: { enrollmentIds: [] },
        destroyed: {
          activeRefreshCredentials: 1,
          refreshCredentialRows: 3,
          devicesPastFirstGeneration: 1,
          // The row migration 0001 seeded, which nothing has read since lane W3-S8.
          systemGenerationRows: 1,
        },
        installedClientCheck: {
          automated: false,
          clientVersionsSeen: [
            { clientVersion: '1.0.13', devices: 1 },
            { clientVersion: '1.0.14', devices: 1 },
          ],
        },
      },
    });
    const confirm = String(
      ((report['counts'] as { installedClientCheck?: { confirm?: unknown } }).installedClientCheck ?? {}).confirm ?? '',
    );
    expect(confirm).toContain('1.0.14');

    // Read-only: the transaction is rolled back, so the rows it counted are all still there.
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM device_refresh_credentials',
    );
    expect(rows[0]?.count).toBe('3');
  });

  it('blocks on a review_required enrollment and names its ids', async () => {
    // A session that answers the three exported statements, because building a live
    // enrollment in that state means the whole sequence chain and this is a claim about
    // the refusal rather than about enrollment. The statements themselves are the ones
    // the test above ran against the real schema.
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const stub: SessionQueryable = {
      async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string) {
        if (text.includes('to_regclass')) {
          return await Promise.resolve({ rows: [{ present: true }] as unknown as Row[], rowCount: 1 });
        }
        if (text.includes('max(version)')) {
          return await Promise.resolve({ rows: [{ version: 20 }] as unknown as Row[], rowCount: 1 });
        }
        if (text === SCHEMA_PREFLIGHT_0021_COUNTS_SQL) {
          return await Promise.resolve({
            rows: [
              {
                review_required_enrollments: '2',
                active_refresh_credentials: '0',
                refresh_credential_rows: '0',
                devices_past_first_generation: '0',
                system_generation_rows: '1',
              },
            ] as unknown as Row[],
            rowCount: 1,
          });
        }
        if (text === SCHEMA_PREFLIGHT_0021_REVIEW_REQUIRED_SQL) {
          return await Promise.resolve({ rows: ids.map(id => ({ id })) as unknown as Row[], rowCount: ids.length });
        }
        if (text === SCHEMA_PREFLIGHT_0021_CLIENT_VERSIONS_SQL) {
          return await Promise.resolve({ rows: [] as Row[], rowCount: 0 });
        }
        // BEGIN and ROLLBACK.
        return await Promise.resolve({ rows: [] as Row[], rowCount: 0 });
      },
    };

    const preflight = await readSchemaPreflight0021(stub);
    expect(preflight.applicable).toBe(true);
    if (!preflight.applicable) return;
    expect(preflight.refuses).toBe(true);
    expect(preflight.counts.blocking.reviewRequiredEnrollments).toBe(2);
    expect(preflight.counts.reviewRequired.enrollmentIds).toEqual(ids);
    // The destroyed counts travel whatever the refusal says: the coordinator takes the
    // whole report to the owner.
    expect(preflight.counts.destroyed.systemGenerationRows).toBe(1);
  });

  it('refuses on any schema but 20, so a report is never read against the wrong database', async () => {
    const { code } = await run(['migrate']);
    expect(code).toBe(0);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(21);
    const applied = await run(['admin', 'schema-preflight', '0021']);
    expect(applied.code).toBe(20);
    expect(applied.stderr).toContain('schema_not_20');
  });
});
