import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CURRENT_SCHEMA_VERSION, repositoryContext, workspaceScope, type SessionQueryable } from '@fss/domain/db';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession } from '@fss/domain/db/testing';
import { ALL_BLOCKED_ACTION_KINDS, openHold } from '@fss/domain/policy';
import { readWorkerDeployment } from '../src/bootstrap/deployment.ts';
import { composeHandlers } from '../src/bootstrap/main.ts';
import { main } from '../src/tools/fss.ts';
import {
  mailboxWatchRenewCommand,
  suppressionJournalReplayCommand,
  systemGenerationAdvanceCommand,
  type AdminInvocation,
} from '../src/tools/fss/admin.ts';
import { readToolConfig } from '../src/tools/fss/config.ts';
import { runMigrate } from '../src/tools/fss/migrate.ts';

/**
 * `fss`, end to end, against a real PostgreSQL (lane G12g).
 *
 * The first half is the command the deployment does not have: `fss migrate` against an
 * **unmigrated** database, which is the state a fresh apply leaves and the state in
 * which both binaries refuse to start. The second half is the `fss admin` surface the
 * restore drill calls, each command run through `main` exactly as the drill runs it.
 *
 * ## The vacuous-pass trap, named
 *
 * Two of them. A migrate test against a database that was already migrated proves
 * nothing, so this file creates its own empty database rather than using
 * `createTestDatabase` — and asserts the version was 0 before and
 * `CURRENT_SCHEMA_VERSION` after, which is the only pair of numbers that says the
 * command did the work. And a tool test that asserted "exit code 0" would pass against
 * a tool that printed nothing: every case reads the JSON the command wrote, through
 * `--report` or through stdout, and asserts a field the drill itself parses.
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

describe('the fss admin commands the drill calls', () => {
  let workspaceId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const workspace = await session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('drill', 'Drill') RETURNING id",
    );
    workspaceId = workspace.rows[0]?.id ?? '';
    const user = await session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`sub-${randomUUID()}`, 'admin@example.test', 'Admin'],
    );
    adminUserId = user.rows[0]?.id ?? '';
    await session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, adminUserId],
    );
  });

  it('counts the five kinds, so a drill with nothing to reconstruct is visible', async () => {
    const { code, stdout } = await run([
      'admin',
      'counts',
      '--as-of',
      '2026-09-20T00:00:00.000Z',
      '--report',
      join(reports, 'baseline.json'),
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    for (const kind of ['sends', 'replies', 'suppressions', 'crm_edits', 'migrations']) {
      expect(report[kind], `the drill reads ${kind}`).toBe(0);
    }
    expect(readReport('baseline.json')['asOf']).toBe('2026-09-20T00:00:00.000Z');
  });

  it('prints a bare integer for --count, because the drill compares it in the shell', async () => {
    const context = repositoryContext(workspaceScope(workspaceId, MIGRATION_SCOPE), session);
    await openHold(context, {
      scopeKind: 'workspace',
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: 'restore.generation_mismatch',
    });

    const counted = await run(['admin', 'holds', 'list', '--reason', 'restore_in_progress', '--count']);
    expect(counted.code).toBe(0);
    expect(counted.stdout.trim()).toBe('1');
    expect(Number.parseInt(counted.stdout.trim(), 10)).toBe(1);

    const listed = await run(['admin', 'holds', 'list', '--exclude-reason', 'restore_in_progress', '--count']);
    expect(listed.stdout.trim()).toBe('0');
  });

  it('refuses to answer a dial nobody could make rather than reporting a refusal', async () => {
    const { code } = await run(['admin', 'dial-authorize', '--any']);
    // Exit 20: a probe that found no subject must not report "refused, restore in
    // progress", which is the vacuous pass this drill exists to prevent.
    expect(code).toBe(20);
  });

  it('discards runnable job state and keeps the dead jobs', async () => {
    const { code, stdout } = await run(['admin', 'jobs', 'discard-runnable', '--report', join(reports, 'jobs.json')]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ discarded: 0, dead_kept: 0 });
    expect(readReport('jobs.json')).toHaveProperty('discarded');
  });

  it('runs one scheduler pass, which is how job state is rematerialised', async () => {
    const { code, stdout } = await run([
      'admin',
      'scheduler',
      'run-once',
      '--report',
      join(reports, 'rematerialise.json'),
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report['outcome']).toBe('ran');
    expect(report['externalActions']).toBe(0);
  });

  it('reports mailbox coverage, and an unconnected environment has nothing to report', async () => {
    const { code, stdout } = await run([
      'admin',
      'mailbox',
      'coverage',
      '--all-mailboxes',
      '--report',
      join(reports, 'coverage.json'),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ mailboxes: [] });
  });

  it('refuses the mail commands when this deployment was given no Gmail, rather than doing half of one', async () => {
    const recover = await run([
      'admin',
      'mailbox',
      'recover',
      '--since',
      '2026-09-20T00:00:00Z',
      '--all-mailboxes',
    ]);
    expect(recover.code).toBe(20);
    const reconcile = await run([
      'admin',
      'mailbox',
      'reconcile-sent',
      '--since',
      '2026-09-20T00:00:00Z',
      '--all-mailboxes',
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

  it('composes the step 8 report, and reports the CRM recovery point as a number', async () => {
    const { code, stdout } = await run([
      'admin',
      'restore-report',
      '--before',
      join(reports, 'baseline.json'),
      '--out',
      join(reports, 'restore-report.json'),
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report['sends_repeated']).toBe(0);
    expect(typeof report['crm_rpo_seconds']).toBe('number');
    expect(report['suppressions_after']).toBeGreaterThanOrEqual(report['suppressions_before'] as number);
    expect(readReport('restore-report.json')).toHaveProperty('unresolved');
  });

  it('advances the generation only for a named active admin, and releases the restore hold only', async () => {
    const invocation = (options: Record<string, string>): AdminInvocation => ({
      session,
      config: readToolConfig({ DATABASE_URL: databaseUrl }),
      environment: {},
      options: { '--report': join(reports, 'restore-report.json'), ...options },
      switches: new Set(),
    });

    // Nobody named: the row's own constraint requires attribution and so does
    // Appendix E step 9.
    expect(await systemGenerationAdvanceCommand(invocation({}))).toMatchObject({
      ok: false,
      reason: 'admin_missing',
    });
    const advanced = await systemGenerationAdvanceCommand(invocation({ '--admin-user': adminUserId }));
    expect(advanced).toMatchObject({ ok: true });
    if (advanced.ok) {
      expect(advanced.value['generation']).toBe(2);
      expect(advanced.value['releasedRestoreHolds']).toBe(1);
    }
    const remaining = await run(['admin', 'holds', 'list', '--reason', 'restore_in_progress', '--count']);
    expect(remaining.stdout.trim()).toBe('0');
  });

  it('renews watches with the Gmail client the deployment named, and never a third one', async () => {
    // `FSS_DEPENDENCIES=recorded` is the rehearsal's *named* choice, so the recorded
    // client is reached deliberately rather than by omission. With no mailbox connected
    // there is nothing to renew, which is the honest answer and reaches no network.
    const environment = {
      FSS_ENVIRONMENT: 'rehearsal',
      FSS_DEPENDENCIES: 'recorded',
      AWS_REGION: 'us-east-1',
      FSS_PUBLIC_ORIGIN: 'https://api.example.test',
      FSS_GMAIL_PUSH_AUDIENCE: 'https://api.example.test/integrations/gmail/push',
      FSS_GMAIL_PUSH_SERVICE_ACCOUNT: 'push@example.iam.gserviceaccount.test',
      FSS_GMAIL_PUSH_TOPIC: 'projects/example/topics/push',
      FSS_GOOGLE_HOSTED_DOMAIN: 'example.test',
      'google-gmail-oauth-client': JSON.stringify({
        client_id: 'example.apps.googleusercontent.test',
        client_secret: `zz-${randomUUID()}-zz`,
      }),
    };
    const deployment = await readWorkerDeployment(environment);
    const composition = await composeHandlers(deployment, undefined, {
      journal: { append: async () => await Promise.resolve() },
      region: 'us-east-1',
    });
    expect(composition.mail, 'the recorded deployment composes a mail client').toBeDefined();

    const outcome = await mailboxWatchRenewCommand({
      session,
      config: readToolConfig({ DATABASE_URL: databaseUrl }),
      environment,
      options: {},
      switches: new Set(['--all-mailboxes']),
      mail: composition.mail,
    });
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(outcome.value).toEqual({ renewed: 0, mailboxes: [] });
  });
});
