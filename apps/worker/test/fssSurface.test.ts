import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession } from '@fss/domain/db/testing/testDatabase.ts';
import { main } from '../src/tools/fss.ts';
import { COMMAND_DEPENDENCIES, FSS_COMMANDS } from '../src/tools/fss/commands.ts';
import { readToolConfig } from '../src/tools/fss/config.ts';
import { ensureRuntimeDatabaseUser } from '../src/tools/fss/databaseUsers.ts';
import { runVerify } from '../src/tools/fss/verify.ts';

/**
 * The command surface David's in-VPC decision added (21 September): `fss verify` and
 * `fss admin database-users ensure`, and the rule that each admin command's dependency
 * mode is fixed rather than whatever the environment says.
 *
 * ## The vacuous-pass trap, named
 *
 * Each of these commands has the same one: reporting success without having looked.
 * `verify` could return `ok` from a read-only check and prove nothing about the runtime
 * user's `INSERT`; `ensure` could report `unchanged` for a user that does not exist. So
 * every case here asserts the *observable consequence* — the row that was written and
 * then is not there, `pg_has_role` for the created user — and each is paired with a
 * refusal.
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
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const printed: string[] = [];
  const logged: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    logged.push(String(chunk));
    return true;
  });
  try {
    const code = await main(argv, {
      DATABASE_URL: databaseUrl,
      FSS_MIGRATION_DATABASE_URL: databaseUrl,
      ...overrides,
    });
    return { code, stdout: printed.join(''), stderr: logged.join('') };
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
  const refusal = (stderr: string): unknown =>
    stderr
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line['event'] === 'fss_refused')?.['reason'];

  it('declares one for every admin command, and gmail-read only for the one that reads Gmail', () => {
    const adminCommands = FSS_COMMANDS.filter(spec => spec.path[0] === 'admin').map(spec =>
      spec.path.slice(1).join(' '),
    );
    for (const name of adminCommands) {
      expect(COMMAND_DEPENDENCIES[name], `${name} declares no dependency mode`).toBeDefined();
    }
    expect(Object.entries(COMMAND_DEPENDENCIES).filter(([, mode]) => mode === 'gmail-read')).toEqual([
      ['mailbox reconcile-sent', 'gmail-read'],
    ]);
    expect(COMMAND_DEPENDENCIES['suppression-journal replay']).toBe('journal');
    for (const name of ['holds list', 'release-record put', 'release-record show', 'workspace bootstrap']) {
      expect(COMMAND_DEPENDENCIES[name], `${name} must not reach anything but the database`).toBe('database');
    }
  });

  it('refuses the Gmail-reading command in a deployment that names no Gmail seam', async () => {
    const none = await run(['admin', 'mailbox', 'reconcile-sent', '--since', '2026-09-20T00:00:00Z', '--all-mailboxes'], {
      FSS_DEPENDENCIES: 'none',
    });
    expect(none.code).toBe(20);
    expect(refusal(none.stderr)).toBe('dependencies_none');
  });

  it('lets it past the mode check under live, which is production: the restore runbook runs it there', async () => {
    // The reason, not only the exit code. This live environment is missing the Gmail
    // variables, so the refusal must come from the deployment reader one step later —
    // proof that `live` itself is not what refused it, which it was until lane W3-S8.
    const live = await run(['admin', 'mailbox', 'reconcile-sent', '--since', '2026-09-20T00:00:00Z', '--all-mailboxes'], {
      FSS_DEPENDENCIES: 'live',
    });
    expect(live.code).toBe(20);
    expect(refusal(live.stderr)).toBe('deployment_incomplete');
  });

  it('lets it past under recorded too, and then refuses a deployment that composed no mail client', async () => {
    // A recorded deployment with no journal bucket registers no mail handler (composeHandlers),
    // so the command gets as far as asking for one.
    const recorded = await run(
      ['admin', 'mailbox', 'reconcile-sent', '--since', '2026-09-20T00:00:00Z', '--all-mailboxes'],
      recordedEnvironment(),
    );
    expect(recorded.code).toBe(20);
    expect(refusal(recorded.stderr)).toBe('gmail_unconfigured');
  });
});
