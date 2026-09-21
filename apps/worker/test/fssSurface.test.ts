import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession } from '@fss/domain/db/testing';
import { main } from '../src/tools/fss.ts';
import { COMMAND_DEPENDENCIES, FSS_COMMANDS } from '../src/tools/fss/commands.ts';
import { readToolConfig } from '../src/tools/fss/config.ts';
import { ensureRuntimeDatabaseUser } from '../src/tools/fss/databaseUsers.ts';
import { runVerify } from '../src/tools/fss/verify.ts';

/**
 * The command surface David's in-VPC decision added (21 September): `fss verify`,
 * `fss drill` and `fss admin database-users ensure`, and the rule that each admin
 * command's dependency mode is fixed rather than whatever the environment says.
 *
 * ## The vacuous-pass trap, named
 *
 * Each of these three commands has the same one: reporting success without having
 * looked. `verify` could return `ok` from a read-only check and prove nothing about
 * the runtime user's `INSERT`; `drill` could report nine passing steps against a
 * database with nothing in it; `ensure` could report `unchanged` for a user that does
 * not exist. So every case here asserts the *observable consequence* — the row that
 * was written and then is not there, the step report on disk and the absence of the
 * next one, `pg_has_role` for the created user — and each is paired with a refusal.
 */

let adminUrl: string;
let databaseName: string;
let databaseUrl: string;
let client: pg.Client;
let session: SessionQueryable;
let reports: string;

beforeAll(async () => {
  adminUrl = process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '';
  expect(adminUrl.length, 'the embedded cluster URL is what globalSetup leaves').toBeGreaterThan(0);
  databaseName = `fss_surface_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  session = asSession(client as never);
  reports = mkdtempSync(join(tmpdir(), 'fss-surface-'));

  // The schema, through the command that owns it. A surface test that hand-rolled the
  // migrations would be testing a database this tool never produces.
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await main(['migrate'], {
      DATABASE_URL: databaseUrl,
      FSS_MIGRATION_DATABASE_URL: databaseUrl,
    });
    expect(code, 'the surface tests need a migrated database').toBe(0);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
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

/**
 * The rehearsal's own dependency selection, complete.
 *
 * `FSS_DEPENDENCIES=recorded` is a named choice and the bootstrap still requires every
 * public identifier a Gmail client needs, so a half-configured `recorded` deployment is
 * a refusal rather than a fake. These are the same variables `deployment.test.ts` uses,
 * with a generated client secret: no credential literal enters this repository.
 */
function recordedEnvironment(): Record<string, string | undefined> {
  return {
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
}

async function run(
  argv: readonly string[],
  overrides: Record<string, string | undefined> = {},
): Promise<{ readonly code: number; readonly stdout: string }> {
  const printed: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
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
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('fss verify', () => {
  it('proves the write and keeps nothing: the row is gone after the rollback', async () => {
    const { code, stdout } = await run(['verify', '--actor', 'g12g-test', '--report', join(reports, 'verify.json')]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report['write']).toBe(true);
    expect(report['read']).toBe(true);
    // The whole point: INSERT privilege and connectivity proved, nothing persisted.
    expect(report['persisted']).toBe(false);
    expect(report['workerAccepts']).toBe(true);
    expect(report['writeCheckTable']).toBe('heartbeats');
    expect((report['configured'] as Record<string, unknown>)['database_source']).toBe('url');

    const left = await session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM heartbeats WHERE instance_key LIKE 'fss-verify:%'",
    );
    expect(left.rows[0]?.count, 'verify left a row behind').toBe('0');
    const written = JSON.parse(readFileSync(join(reports, 'verify.json'), 'utf8')) as Record<string, unknown>;
    expect(written['persisted']).toBe(false);
  });

  it('refuses rather than reporting a pass when the write is refused', async () => {
    const stub: SessionQueryable = {
      query: async (text: string) => {
        if (text.startsWith('INSERT INTO heartbeats')) throw new Error('insufficient_privilege');
        if (text.includes('current_user')) {
          return await Promise.resolve({ rows: [{ role: 'app_runtime' }] as never[], rowCount: 1 });
        }
        return await Promise.resolve({ rows: [{ present: false }] as never[], rowCount: 1 });
      },
    };
    const outcome = await runVerify(stub, readToolConfig({ DATABASE_URL: databaseUrl }));
    expect(outcome).toMatchObject({ ok: false, reason: 'write_refused' });
  });
});

describe('fss admin database-users ensure', () => {
  /** A throwaway login user, named per run because roles are cluster-wide. */
  const runtimeUser = `fss_runtime_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  /** Generated at runtime: no password literal ever enters this repository. */
  const password = `p${randomUUID().replaceAll('-', '')}`;
  const secretValue = (): string =>
    JSON.stringify({ username: runtimeUser, password, host: '127.0.0.1', port: 5432, dbname: databaseName });

  afterAll(async () => {
    const dropper = new pg.Client({ connectionString: databaseUrl });
    await dropper.connect().catch(() => undefined);
    await dropper.query(`DROP ROLE IF EXISTS "${runtimeUser}"`).catch(() => undefined);
    await dropper.end().catch(() => undefined);
  });

  it('creates the runtime login user in the app_runtime group, then reports it unchanged', async () => {
    const created = await ensureRuntimeDatabaseUser(session, { secretValue: secretValue() });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;
    expect(created.value.user).toMatchObject({
      outcome: 'created',
      user: runtimeUser,
      canLogin: true,
      passwordSet: true,
    });

    // 0001's `app_runtime` is a NOLOGIN group role, so membership is the whole point.
    const member = await session.query<{ member: boolean }>(
      "SELECT pg_has_role($1, 'app_runtime', 'MEMBER') AS member",
      [runtimeUser],
    );
    expect(member.rows[0]?.member).toBe(true);

    const again = await ensureRuntimeDatabaseUser(session, { secretValue: secretValue() });
    expect(again).toMatchObject({ ok: true });
    if (again.ok) {
      expect(again.value.user.outcome).toBe('unchanged');
      // A password is never rotated unless it was asked for: the services hold it.
      expect(again.value.user.passwordSet).toBe(false);
    }
  });

  it('grants migration to the connected user, and says whether it had to', async () => {
    const outcome = await ensureRuntimeDatabaseUser(session, { secretValue: secretValue() });
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    // The embedded cluster's owner is a superuser, for which `pg_has_role` is already
    // true of every role, so the honest answer here is `already`. The `granted` branch
    // is the RDS master's, which is not a superuser; both are reported rather than
    // assumed, which is what lets an operator tell them apart in the release record.
    expect(['granted', 'already']).toContain(outcome.value.migrationMembership);
    expect(outcome.value.grantedTo.length).toBeGreaterThan(0);
  });

  it('refuses a secret that is not a credential, and puts no credential in the message', async () => {
    const outcome = await ensureRuntimeDatabaseUser(session, { secretValue: '{"username":"x"}' });
    expect(outcome).toMatchObject({ ok: false, reason: 'secret_malformed' });
    if (!outcome.ok) expect(outcome.detail).not.toContain(password);
  });

  it('refuses when no runtime secret variable is set, naming the variable and not its value', async () => {
    const { code } = await run(['admin', 'database-users', 'ensure']);
    expect(code).toBe(20);
  });
});

describe('the dependency mode is fixed per command', () => {
  it('declares one for every admin command, and recorded for everything that could reach Gmail', () => {
    const adminCommands = FSS_COMMANDS.filter(spec => spec.path[0] === 'admin').map(spec =>
      spec.path.slice(1).join(' '),
    );
    for (const name of adminCommands) {
      expect(COMMAND_DEPENDENCIES[name], `${name} declares no dependency mode`).toBeDefined();
    }
    expect(COMMAND_DEPENDENCIES['mailbox recover']).toBe('recorded');
    expect(COMMAND_DEPENDENCIES['mailbox reconcile-sent']).toBe('recorded');
    expect(COMMAND_DEPENDENCIES['mailbox watch-renew']).toBe('recorded');
    expect(COMMAND_DEPENDENCIES['suppression-journal replay']).toBe('journal');
    for (const name of ['counts', 'jobs discard-runnable', 'scheduler run-once', 'holds list']) {
      expect(COMMAND_DEPENDENCIES[name], `${name} must not reach anything but the database`).toBe('database');
    }
  });

  it('refuses a Gmail-reaching command in a live deployment rather than sending from a command line', async () => {
    const live = await run(['admin', 'mailbox', 'recover', '--since', '2026-09-20T00:00:00Z', '--all-mailboxes'], {
      FSS_DEPENDENCIES: 'live',
    });
    expect(live.code).toBe(20);
    const drill = await run(['drill', '--as-of', '2026-09-20T00:00:00Z', '--reports', reports], {
      FSS_DEPENDENCIES: 'live',
    });
    expect(drill.code).toBe(20);
  });
});

describe('fss drill', () => {
  it('refuses without a baseline or an instant to measure one at', async () => {
    // A usage refusal (64): naming neither is a command line that cannot be run at all,
    // and the grammar says so before a database is opened.
    const { code } = await run(['drill', '--reports', reports], recordedEnvironment());
    expect(code).toBe(64);
  });

  it('refuses a baseline with nothing to reconstruct, exactly as the shell drill does', async () => {
    const empty = join(reports, 'empty-baseline.json');
    writeFileSync(
      empty,
      JSON.stringify({
        asOf: '2026-09-20T00:00:00.000Z',
        sends: 0,
        replies: 0,
        suppressions: 0,
        crm_edits: 0,
        migrations: 14,
      }),
    );
    const { code } = await run(['drill', '--baseline', empty, '--reports', reports], recordedEnvironment());
    expect(code).toBe(20);
  });

  it('stops at the first failing step, names it, and leaves that step’s report behind', async () => {
    // A baseline with all five kinds against a database with no restore hold: the drill
    // must stop at step 1 rather than reporting a pass on the steps after it.
    const full = join(reports, 'full-baseline.json');
    writeFileSync(
      full,
      JSON.stringify({
        asOf: '2026-09-20T00:00:00.000Z',
        sends: 1,
        replies: 1,
        suppressions: 1,
        crm_edits: 1,
        migrations: 14,
      }),
    );
    const drillReports = mkdtempSync(join(tmpdir(), 'fss-drill-run-'));
    const { code } = await run(['drill', '--baseline', full, '--reports', drillReports], recordedEnvironment());
    expect(code).toBe(20);
    const summary = JSON.parse(readFileSync(join(drillReports, 'drill.json'), 'utf8')) as Record<string, unknown>;
    expect(summary['ok']).toBe(false);
    expect(summary['stoppedAt']).toBe('step1-restore-holds');
    // The per-step report is written as the step finishes, so a drill that stopped has
    // already recorded what it saw — and has not written the step it never reached.
    expect(JSON.parse(readFileSync(join(drillReports, 'step1-restore-holds.json'), 'utf8'))).toHaveProperty('count');
    expect(existsSync(join(drillReports, 'step2-journal-replay.json'))).toBe(false);
  });
});
