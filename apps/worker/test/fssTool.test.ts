import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { CURRENT_SCHEMA_VERSION } from '@fss/domain/db/schemaRange.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession } from '@fss/domain/db/testing/testDatabase.ts';
import { openHold } from '@fss/domain/policy/holds.ts';
import { ALL_BLOCKED_ACTION_KINDS } from '@fss/domain/policy/types.ts';
import { main } from '../src/tools/fss.ts';
import { redactedMessageId, suppressionJournalReplayCommand, type AdminInvocation } from '../src/tools/fss/admin.ts';
import { readToolConfig } from '../src/tools/fss/config.ts';
import { runMigrate } from '../src/tools/fss/migrate.ts';

/**
 * `fss`, end to end, against a real PostgreSQL (lane G12g).
 *
 * The first half is the command the deployment does not have: `fss migrate` against an
 * **unmigrated** database, which is the state a fresh apply leaves and the state in
 * which both binaries refuse to start. The second half is the `fss admin` surface a
 * restore and a release run, each command run through `main` as an operator runs it.
 *
 * ## The vacuous-pass trap, named
 *
 * Two of them. A migrate test against a database that was already migrated proves
 * nothing, so this file creates its own empty database rather than using
 * `createTestDatabase` — and asserts the version was 0 before and
 * `CURRENT_SCHEMA_VERSION` after, which is the only pair of numbers that says the
 * command did the work. And a tool test that asserted "exit code 0" would pass against
 * a tool that printed nothing: every case reads the JSON the command wrote, through
 * `--report` or through stdout, and asserts a field an operator reads.
 */

const MIGRATION_SCOPE = { kind: 'system', component: 'migration' } as const;

let adminUrl: string;
let databaseName: string;
let databaseUrl: string;
let client: pg.Client;
let session: SessionQueryable;
let reports: string;

function urlFor(name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

beforeAll(async () => {
  adminUrl = process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '';
  expect(adminUrl.length, 'the embedded cluster URL is what globalSetup leaves').toBeGreaterThan(0);
  databaseName = `fss_fsstool_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  databaseUrl = urlFor(databaseName);
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  session = asSession(client as never);
  reports = mkdtempSync(join(tmpdir(), 'fss-tool-'));
});

afterAll(async () => {
  await client.end().catch(() => undefined);
  const dropper = new pg.Client({ connectionString: adminUrl });
  await dropper.connect();
  try {
    await dropper.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await dropper.end();
  }
});

/** Run the tool and hand back its exit code and everything it printed to stdout. */
async function run(
  argv: readonly string[],
  overrides: Record<string, string | undefined> = {},
): Promise<{ readonly code: number; readonly stdout: string }> {
  // The migration credential is its own variable, never `DATABASE_URL`. The embedded
  // cluster has one superuser, so both point at the same place here; what the tool is
  // being held to is that it refuses to apply DDL unless the migration credential was
  // configured *as one*, which the next test proves by leaving it out.
  const printed: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await main(argv, {
      DATABASE_URL: databaseUrl,
      FSS_MIGRATION_DATABASE_URL: databaseUrl,
      ...overrides,
    });
    return { code, stdout: printed.join('') };
  } finally {
    spy.mockRestore();
    stderr.mockRestore();
  }
}

function readReport(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(reports, name), 'utf8')) as Record<string, unknown>;
}

describe('fss migrate', () => {
  it('takes an empty database to the current schema version and says what it applied', async () => {
    const before = await session.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_versions') IS NOT NULL AS present",
    );
    expect(before.rows[0]?.present, 'the database this test migrates must start empty').toBe(false);

    const { code, stdout } = await run(['migrate', '--report', join(reports, 'migrate.json')]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report['schemaVersionBefore']).toBe(0);
    expect(report['schemaVersionAfter']).toBe(CURRENT_SCHEMA_VERSION);
    expect((report['applied'] as unknown[]).length).toBe(CURRENT_SCHEMA_VERSION);
    // The role the run created. Migration 0001 makes it, so the first run cannot
    // connect as it and the report says which role actually applied the files.
    expect(report['role']).toMatchObject({ migrationRoleExists: true });
    // `--report` writes the same bytes to the file the deployment collects.
    expect(readReport('migrate.json')['schemaVersionAfter']).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('runs with the migration credential alone, the way the migration task definition is shaped', async () => {
    // infra/modules/cluster injects exactly MIGRATION_DATABASE_SECRET and
    // FSS_RUNTIME_DATABASE_SECRET_ARN into the migration task, and no DATABASE_SECRET_ARN
    // (tests/migration_identity.tftest.hcl). Both runs of 23 September 2026 exited 20 here
    // because the tool demanded the runtime connection before it looked at the command.
    const url = new URL(databaseUrl);
    const secret = JSON.stringify({
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: Number(url.port || 5432),
      dbname: url.pathname.slice(1),
    });
    const printed: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      printed.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['migrate', '--report', join(reports, 'migrate-secret-only.json')], {
        MIGRATION_DATABASE_SECRET: secret,
        FSS_RUNTIME_DATABASE_SECRET_ARN: secret,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    const report = JSON.parse(printed.join('')) as Record<string, unknown>;
    expect(report['schemaVersionAfter']).toBe(CURRENT_SCHEMA_VERSION);
    expect(readReport('migrate-secret-only.json')['schemaVersionAfter']).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('admin database-users ensure runs with the migration credential alone too, as the task definition is shaped', async () => {
    // Run 35883201716 (23 September 2026) migrated the database and then refused this
    // command with the exact message migrate had been refused with the run before.
    const url = new URL(databaseUrl);
    const migration = JSON.stringify({
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: Number(url.port || 5432),
      dbname: url.pathname.slice(1),
    });
    const runtimeUser = `fss_rt_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const runtime = JSON.stringify({
      username: runtimeUser,
      password: `p${randomUUID().replaceAll('-', '')}`,
      host: url.hostname,
      port: Number(url.port || 5432),
      dbname: url.pathname.slice(1),
    });
    const printed: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      printed.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['admin', 'database-users', 'ensure'], {
        MIGRATION_DATABASE_SECRET: migration,
        FSS_RUNTIME_DATABASE_SECRET_ARN: runtime,
      });
      expect(code).toBe(0);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      await session.query(`DROP ROLE IF EXISTS "${runtimeUser}"`).catch(() => undefined);
    }
    const report = JSON.parse(printed.join('')) as { user?: { outcome?: string; user?: string } };
    expect(report.user?.outcome).toBe('created');
    expect(report.user?.user).toBe(runtimeUser);
  });

  it('every other command still refuses without the runtime credential, and names both variables', async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      lines.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['migrate', 'status'], { FSS_MIGRATION_DATABASE_URL: databaseUrl })).toBe(20);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
    const output = lines.join('');
    expect(output).toContain('fss_configuration_refused');
    expect(output).toContain('DATABASE_SECRET_ARN');
    expect(output).not.toContain(databaseUrl);
  });

  it('refuses to apply anything with the runtime credential, whatever DATABASE_URL points at', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      // The runtime connection is present and usable; the migration one is not
      // configured, and that is the whole reason for the refusal.
      expect(await main(['migrate'], { DATABASE_URL: databaseUrl })).toBe(20);
    } finally {
      spy.mockRestore();
      stdout.mockRestore();
    }
  });

  it('refuses when the session is app_runtime, whatever flags it was given', async () => {
    // `app_runtime` may never apply DDL. The refusal is before `--allow-any-role` is
    // read, so a flag meant for a superuser repair cannot reach it.
    const stub: SessionQueryable = {
      query: async (text: string) => {
        if (text.includes('to_regrole')) {
          return await Promise.resolve({ rows: [{ role: 'app_runtime', exists: true }] as never[], rowCount: 1 });
        }
        throw new Error(`the refusal should have happened before: ${text}`);
      },
    };
    expect(await runMigrate(stub, { allowAnyRole: true })).toMatchObject({
      ok: false,
      reason: 'runs_as_app_runtime',
    });
  });

  it('is idempotent: a second run applies nothing and still reports the version', async () => {
    const { code, stdout } = await run(['migrate', 'up']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report['applied']).toEqual([]);
    expect(report['schemaVersionAfter']).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses a role that is not the migration role, and --allow-any-role is the deliberate override', async () => {
    // A stub session, because the refusal happens before a statement is applied and
    // the embedded cluster's superuser is a member of every role there is.
    const stub: SessionQueryable = {
      query: async (text: string) => {
        if (text.includes('to_regrole')) {
          return await Promise.resolve({ rows: [{ role: 'fss_app', exists: true }] as never[], rowCount: 1 });
        }
        if (text.includes('pg_has_role')) {
          return await Promise.resolve({ rows: [{ member: false }] as never[], rowCount: 1 });
        }
        throw new Error(`the refusal should have happened before: ${text}`);
      },
    };
    const outcome = await runMigrate(stub);
    expect(outcome).toMatchObject({ ok: false, reason: 'not_migration_role' });
  });

  it('reads the schema version without writing, and says whether each binary would start', async () => {
    const { code, stdout } = await run(['schema-version']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report['schemaVersion']).toBe(CURRENT_SCHEMA_VERSION);
    expect(report['pending']).toEqual([]);
    expect(report['workerAccepts']).toBe(true);
    expect(report['apiAccepts']).toBe(true);
  });
});

describe('fss --selftest', () => {
  it('refuses when no database is configured, and names no value', async () => {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      stderr.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      expect(await main(['--selftest'], {})).toBe(20);
    } finally {
      spy.mockRestore();
      stdout.mockRestore();
    }
    const output = stderr.join('');
    expect(output).toContain('fss_configuration_refused');
    expect(output).not.toContain(databaseUrl);
  });

  it('names its decisions when it is configured, and reaches no database', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      lines.push(String(chunk));
      return true;
    });
    try {
      expect(await main(['--selftest'], { DATABASE_URL: databaseUrl })).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const line = JSON.parse(lines.join('').trim()) as Record<string, unknown>;
    expect(line['event']).toBe('fss_selftest');
    expect(line['database_source']).toBe('url');
    expect(line['migration_from']).toBe('absent');
    expect(line['journal']).toBe('absent');
  });

  it('refuses an unknown command rather than doing something near it', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['admin', 'counts', '--every'], { DATABASE_URL: databaseUrl })).toBe(64);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the fss admin commands a restore runs', () => {
  let workspaceId: string;

  beforeAll(async () => {
    const workspace = await session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('restore', 'Restore') RETURNING id",
    );
    workspaceId = workspace.rows[0]?.id ?? '';
  });

  it('lists the open holds by reason, as JSON', async () => {
    const context = repositoryContext(workspaceScope(workspaceId, MIGRATION_SCOPE), session);
    await openHold(context, {
      scopeKind: 'workspace',
      reasonCode: 'long_hold_review',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: 'test.long_hold',
    });

    const listed = await run(['admin', 'holds', 'list', '--reason', 'long_hold_review', '--report', join(reports, 'holds.json')]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ count: 1, reason: 'long_hold_review', excludeReason: null });
    expect(readReport('holds.json')).toMatchObject({ count: 1 });

    const others = await run(['admin', 'holds', 'list', '--exclude-reason', 'long_hold_review']);
    expect(JSON.parse(others.stdout)).toMatchObject({ count: 0 });
  });

  it('refuses the Sent-folder reconciliation when this deployment names no Gmail, rather than doing half of one', async () => {
    const reconcile = await run([
      'admin',
      'mailbox',
      'reconcile-sent',
      '--since',
      '2026-09-20T00:00:00Z',
      '--inventory-host',
      'fss-prod-pg.example.test',
      '--inventory-marker',
      '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    ]);
    expect(reconcile.code).toBe(20);
  });

  it('refuses a journal replay with no journal configured', async () => {
    const { code } = await run(['admin', 'suppression-journal', 'replay', '--from', '2026-09-20T00:00:00Z']);
    expect(code).toBe(20);
  });

  it('replays the records a journal source hands it, and the second replay inserts nothing', async () => {
    // The S3 client is the only part not exercised here, deliberately: no test in this
    // repository reaches a network. The source is the port `journalSource.ts` implements.
    const record = {
      eventId: `sup_${'a'.repeat(64)}`,
      workspaceId,
      scope: 'handle' as const,
      canonicalKey: 'replayed@example.test',
      canonicalizerVersion: 'handle.1',
      source: 'prospect_opt_out',
      actorUserId: null,
      commandId: null,
      supersedesEventId: null,
      supersessionReason: null,
      recordedAt: '2026-09-20T00:00:00.000Z',
    };
    const invocation: AdminInvocation = {
      session,
      config: readToolConfig({ DATABASE_URL: databaseUrl }),
      environment: {},
      options: { '--from': '2026-09-19T00:00:00Z' },
      switches: new Set(),
      journalSource: { read: async () => await Promise.resolve([record]) },
    };
    const first = await suppressionJournalReplayCommand(invocation);
    expect(first).toMatchObject({ ok: true });
    if (first.ok) expect(first.value['inserted']).toBe(1);
    const second = await suppressionJournalReplayCommand(invocation);
    if (second.ok) expect(second.value['inserted']).toBe(0);
  });

  it('keeps a Message-ID in a report only as a hash (lane g73)', () => {
    expect(redactedMessageId('<fss.00000000-0000-4000-8000-000000000001@example.test>')).toMatch(/^[0-9a-f]{16}$/u);
    expect(redactedMessageId('<a@example.test>')).not.toBe(redactedMessageId('<b@example.test>'));
  });
});

/**
 * `fss admin workspace bootstrap` (lane g39).
 *
 * The command that closes the circularity in specification 5.1: sign-in refuses
 * without a workspace, refuses again without an active membership, and creates the
 * `users` row only at the end of a successful sign-in — so before this command
 * nothing could make the first of the three rows exist.
 *
 * ## The vacuous-pass trap, named
 *
 * "It exits 0" is worthless here twice over. A command that inserted a workspace and
 * no membership would exit 0 and leave an environment nobody can sign in to, and a
 * command that inserted a *second* workspace on every run would exit 0 too and be
 * discovered when two canaries appeared. So every case reads the three tables back —
 * by count as well as by content — and the idempotence case asserts the counts did
 * not move rather than asserting the report said `existing`.
 */
describe('fss admin workspace bootstrap', () => {
  const countOf = async (table: string, where: string, values: readonly unknown[]): Promise<number> => {
    const { rows } = await session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
      values,
    );
    return Number(rows[0]?.count ?? '0');
  };

  it('creates the workspace, a provisional admin and an active admin membership, in one report', async () => {
    const { code, stdout } = await run([
      'admin',
      'workspace',
      'bootstrap',
      '--slug',
      'first',
      '--display-name',
      'First Workspace',
      '--admin-email',
      'First.Admin@Example.Test',
      '--report',
      join(reports, 'bootstrap.json'),
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      workspace: { id: string; slug: string; displayName: string; businessTimeZone: string; outcome: string };
      admin: { userId: string; email: string; outcome: string };
      membership: { role: string; outcome: string };
    };
    expect(report.workspace.slug).toBe('first');
    expect(report.workspace.outcome).toBe('created');
    expect(report.workspace.displayName).toBe('First Workspace');
    // The default the column carries, stated in the report rather than implied.
    expect(report.workspace.businessTimeZone).toBe('America/New_York');
    // The UUID is the whole point of the report: it is what the desktop's Workspace
    // field takes, so a report without a readable one is a report nobody can use.
    expect(report.workspace.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(report.admin.outcome).toBe('provisional_created');
    // Lowercased on the way in, because `users_email_shape` requires it.
    expect(report.admin.email).toBe('first.admin@example.test');
    expect(report.membership).toEqual({ role: 'admin', outcome: 'created' });

    // The three rows, read back rather than inferred from the report.
    const user = await session.query<{ google_sub: string; display_name: string }>(
      'SELECT google_sub, display_name FROM users WHERE id = $1',
      [report.admin.userId],
    );
    expect(user.rows[0]?.google_sub).toBe('pending-email:first.admin@example.test');
    expect(user.rows[0]?.display_name).toBe('first.admin');
    const membership = await session.query<{ role: string; status: string; deactivated_at: Date | null }>(
      'SELECT role, status, deactivated_at FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
      [report.workspace.id, report.admin.userId],
    );
    expect(membership.rows[0]).toMatchObject({ role: 'admin', status: 'active', deactivated_at: null });

    // And the audit row. `operator` is not an `actor_kind` migration 0001 allows —
    // the four are user, admin, system, worker — so the actor is `system` and the
    // command names itself in the detail.
    const audit = await session.query<{ actor_kind: string; action: string; detail: Record<string, unknown> }>(
      'SELECT actor_kind, action, detail FROM audit_events WHERE workspace_id = $1',
      [report.workspace.id],
    );
    expect(audit.rows[0]?.actor_kind).toBe('system');
    expect(audit.rows[0]?.action).toBe('workspace.bootstrapped');
    expect(audit.rows[0]?.detail).toMatchObject({ command: 'fss admin workspace bootstrap', role: 'admin' });
    // A detail never carries an e-mail address (5.2).
    expect(JSON.stringify(audit.rows[0]?.detail)).not.toContain('@');

    expect(readReport('bootstrap.json')).toMatchObject({ workspace: { slug: 'first' } });
  });

  it('is idempotent: a second run adds no row and says so', async () => {
    const before = {
      workspaces: await countOf('workspaces', 'slug = $1', ['first']),
      users: await countOf('users', 'email = $1', ['first.admin@example.test']),
      memberships: await countOf('workspace_memberships', "role = 'admin' AND status = 'active'", []),
    };
    expect(before.workspaces).toBe(1);

    const { code, stdout } = await run([
      'admin',
      'workspace',
      'bootstrap',
      '--slug',
      'first',
      '--display-name',
      'A Different Display Name',
      '--admin-email',
      'first.admin@example.test',
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      workspace: { outcome: string; displayName: string };
      admin: { outcome: string };
      membership: { outcome: string };
    };
    expect(report.workspace.outcome).toBe('existing');
    // A re-run names the workspace it found; it does not rename it.
    expect(report.workspace.displayName).toBe('First Workspace');
    expect(report.admin.outcome).toBe('provisional_existing');
    expect(report.membership.outcome).toBe('existing');

    expect(await countOf('workspaces', 'slug = $1', ['first'])).toBe(before.workspaces);
    expect(await countOf('users', 'email = $1', ['first.admin@example.test'])).toBe(before.users);
    expect(await countOf('workspace_memberships', "role = 'admin' AND status = 'active'", [])).toBe(
      before.memberships,
    );
  });

  it('reactivates a membership somebody deactivated, rather than reporting nothing to do', async () => {
    // Getting into this state takes a second admin: `workspace_memberships_last_active_admin`
    // (migration 0001) refuses an update that would leave a workspace with no active
    // admin at all, so the row this reactivates can only ever have been deactivated
    // while somebody else held the role. That is the real case — an admin who left and
    // came back, or a bootstrap re-run after a clean-up — and it is the one the
    // `UNIQUE (workspace_id, user_id)` constraint leaves nowhere else to put.
    const created = await run([
      'admin',
      'workspace',
      'bootstrap',
      '--slug',
      'rejoined',
      '--display-name',
      'Rejoined',
      '--admin-email',
      'rejoined.admin@example.test',
    ]);
    expect(created.code).toBe(0);
    const first = JSON.parse(created.stdout) as {
      workspace: { id: string };
      admin: { userId: string };
    };

    const other = await session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`sub-${randomUUID()}`, 'other.admin@example.test', 'Other Admin'],
    );
    await session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
      [first.workspace.id, other.rows[0]?.id],
    );
    await session.query(
      `UPDATE workspace_memberships
          SET status = 'inactive', deactivated_at = now(), role = 'salesperson'
        WHERE workspace_id = $1 AND user_id = $2`,
      [first.workspace.id, first.admin.userId],
    );

    const { code, stdout } = await run([
      'admin',
      'workspace',
      'bootstrap',
      '--slug',
      'rejoined',
      '--display-name',
      'Rejoined',
      '--admin-email',
      'rejoined.admin@example.test',
    ]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { membership: { outcome: string } }).membership.outcome).toBe('reactivated');
    const membership = await session.query<{ role: string; status: string; deactivated_at: Date | null }>(
      'SELECT role, status, deactivated_at FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
      [first.workspace.id, first.admin.userId],
    );
    expect(membership.rows[0]).toMatchObject({ role: 'admin', status: 'active', deactivated_at: null });
  });

  it('adopts the account of somebody who has already signed in under that address', async () => {
    const realSub = `1078${randomUUID().replaceAll('-', '').slice(0, 14)}`;
    const existing = await session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [realSub, 'already.here@example.test', 'Already Here'],
    );
    const { code, stdout } = await run([
      'admin',
      'workspace',
      'bootstrap',
      '--slug',
      'second',
      '--display-name',
      'Second',
      '--admin-email',
      'already.here@example.test',
      '--time-zone',
      'America/Los_Angeles',
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      workspace: { businessTimeZone: string };
      admin: { userId: string; outcome: string };
      membership: { outcome: string };
    };
    expect(report.admin.outcome).toBe('adopted_user');
    expect(report.admin.userId).toBe(existing.rows[0]?.id);
    expect(report.membership.outcome).toBe('created');
    expect(report.workspace.businessTimeZone).toBe('America/Los_Angeles');
    // No second row for the address, and the real sub is untouched.
    expect(await countOf('users', 'email = $1', ['already.here@example.test'])).toBe(1);
    const kept = await session.query<{ google_sub: string }>('SELECT google_sub FROM users WHERE id = $1', [
      existing.rows[0]?.id,
    ]);
    expect(kept.rows[0]?.google_sub).toBe(realSub);
  });

  it('registers the sending domain for a workspace that already exists, and a re-run changes nothing (g57)', async () => {
    // Production's case exactly: `callie` was bootstrapped, its admin signed in and its
    // mailbox connected before anything registered a sending domain, so Administration
    // had nowhere to record 12.7's checklist. `first` stands in for it here.
    const { code, stdout } = await run([
      'admin',
      'workspace',
      'bootstrap',
      '--slug',
      'first',
      '--display-name',
      'First Workspace',
      '--admin-email',
      'first.admin@example.test',
      '--sending-domain',
      ' First.Example.Test ',
      '--report',
      join(reports, 'bootstrap-domain.json'),
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      workspace: { id: string; outcome: string };
      sendingDomain: { domain: string; isPrimary: boolean; outcome: string } | null;
    };
    expect(report.workspace.outcome).toBe('existing');
    expect(report.sendingDomain).toEqual({ domain: 'first.example.test', isPrimary: true, outcome: 'created' });
    expect(readReport('bootstrap-domain.json')).toMatchObject({ sendingDomain: { outcome: 'created' } });

    // The row, read back, with every checklist column unticked.
    const row = await session.query<{ is_primary: boolean; spf_pass: boolean; automated_sending_enabled: boolean }>(
      'SELECT is_primary, spf_pass, automated_sending_enabled FROM sending_domains WHERE workspace_id = $1 AND domain = $2',
      [report.workspace.id, 'first.example.test'],
    );
    expect(row.rows).toEqual([{ is_primary: true, spf_pass: false, automated_sending_enabled: false }]);
    // Audited by the registration itself, as the system, naming the operator path.
    const audit = await session.query<{ actor_kind: string; detail: Record<string, unknown> }>(
      "SELECT actor_kind, detail FROM audit_events WHERE workspace_id = $1 AND action = 'sending_domain.registered'",
      [report.workspace.id],
    );
    expect(audit.rows).toEqual([
      { actor_kind: 'system', detail: { domain: 'first.example.test', isPrimary: true, registeredBy: 'operator' } },
    ]);

    // The admin records the checklist; the next deploy's 5.1a re-run must not undo it.
    const admin = await session.query<{ user_id: string }>(
      "SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND role = 'admin' AND status = 'active' LIMIT 1",
      [report.workspace.id],
    );
    await session.query(
      `UPDATE sending_domains
          SET spf_pass = true, dkim_pass = true, dmarc_pass = true,
              authentication_checked_at = now(), authentication_checked_by_user_id = $2,
              postmaster_reviewed_at = now()
        WHERE workspace_id = $1`,
      [report.workspace.id, admin.rows[0]?.user_id],
    );
    const again = await run([
      'admin',
      'workspace',
      'bootstrap',
      '--slug',
      'first',
      '--display-name',
      'First Workspace',
      '--admin-email',
      'first.admin@example.test',
      '--sending-domain',
      'first.example.test',
    ]);
    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as { sendingDomain: unknown }).sendingDomain).toEqual({
      domain: 'first.example.test',
      isPrimary: true,
      outcome: 'existing',
    });
    const kept = await session.query<{ count: string; spf: boolean }>(
      'SELECT count(*)::text AS count, bool_and(spf_pass AND dkim_pass AND dmarc_pass) AS spf FROM sending_domains WHERE workspace_id = $1',
      [report.workspace.id],
    );
    expect(kept.rows[0]).toEqual({ count: '1', spf: true });
  });

  it('reports no sending domain when the flag is absent', async () => {
    const { code, stdout } = await run([
      'admin',
      'workspace',
      'bootstrap',
      '--slug',
      'first',
      '--display-name',
      'First Workspace',
      '--admin-email',
      'first.admin@example.test',
    ]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { sendingDomain: unknown }).sendingDomain).toBeNull();
  });

  it('refuses an address or personal Gmail as the sending domain, before writing anything', async () => {
    for (const domain of ['callie@example.test', 'https://example.test', 'gmail.com']) {
      const { code } = await run([
        'admin',
        'workspace',
        'bootstrap',
        '--slug',
        'not-created',
        '--display-name',
        'Not Created',
        '--admin-email',
        'nobody@example.test',
        '--sending-domain',
        domain,
      ]);
      expect(code, domain).toBe(20);
    }
    expect(await countOf('workspaces', 'slug = $1', ['not-created'])).toBe(0);
  });

  it('refuses a slug, an address and a zone the database would refuse, and writes nothing', async () => {
    const before = await countOf('workspaces', 'true', []);
    for (const argv of [
      ['--slug', 'Not A Slug', '--display-name', 'X', '--admin-email', 'x@example.test'],
      ['--slug', 'ok-slug', '--display-name', 'X', '--admin-email', 'not-an-address'],
      ['--slug', 'ok-slug', '--display-name', '   ', '--admin-email', 'x@example.test'],
      [
        '--slug',
        'ok-slug',
        '--display-name',
        'X',
        '--admin-email',
        'x@example.test',
        '--time-zone',
        'Eastern Time',
      ],
    ]) {
      const { code } = await run(['admin', 'workspace', 'bootstrap', ...argv]);
      // 20, not 21: a mistyped flag is something the operator acts on, and the
      // constraint violation it would otherwise become names a constraint instead.
      expect(code, argv.join(' ')).toBe(20);
    }
    expect(await countOf('workspaces', 'true', [])).toBe(before);
    expect(await countOf('workspaces', 'slug = $1', ['ok-slug'])).toBe(0);
  });

  it('refuses without the three flags it cannot invent, as a usage error', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['admin', 'workspace', 'bootstrap', '--slug', 'x'], { DATABASE_URL: databaseUrl })).toBe(
        64,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
