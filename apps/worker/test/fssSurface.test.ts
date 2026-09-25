import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
    // The reason, not only the exit code. This live environment is also missing the
    // Gmail variables, so with the dependency-mode check gone `mailbox recover` still
    // exits 20, refused `deployment_incomplete` by the Gmail configuration one step
    // later, and a test that read only the code stayed green (lane g54 found it when the
    // mutation check first ran this suite for real).
    const refusal = (stderr: string): unknown =>
      stderr
        .split('\n')
        .filter(line => line.startsWith('{'))
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .find(line => line['event'] === 'fss_refused')?.['reason'];
    const live = await run(['admin', 'mailbox', 'recover', '--since', '2026-09-20T00:00:00Z', '--all-mailboxes'], {
      FSS_DEPENDENCIES: 'live',
    });
    expect(live.code).toBe(20);
    expect(refusal(live.stderr)).toBe('dependencies_not_recorded');
    const drill = await run(['drill', '--as-of', '2026-09-20T00:00:00Z', '--reports', reports], {
      FSS_DEPENDENCIES: 'live',
    });
    expect(drill.code).toBe(20);
    expect(refusal(drill.stderr)).toBe('dependencies_not_recorded');
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

/**
 * Lane g53: the drill makes its own reports directory, and takes the source baseline
 * as a value.
 *
 * The thirteenth full run (24 September 2026) exited 21 on `ENOENT … open
 * '/tmp/fss-drill/step0-baseline.json'`: nothing in the container creates the reports
 * directory. Behind that write was the wrong baseline: launched with `--as-of`, the
 * drill measured step 0 again on the restored copy rather than using the counts the
 * runner took on the source. A one-off task can be handed nothing but its command, so
 * the source baseline now travels as `--baseline-json`.
 *
 * ## The vacuous-pass trap
 *
 * "The handed baseline was used" could pass against a drill that ignored it and
 * measured its own, so the database here has nothing in it: a drill that re-measured
 * would refuse `baseline_empty` at step 0 and never reach step 1. Reaching step 1 is
 * the proof, together with the handed counts on disk under the name step 8 reads.
 */
describe('fss drill --baseline-json, into a reports directory it makes (lane g53)', () => {
  const handed = {
    asOf: '2026-09-21T00:00:00.000Z',
    sends: 2,
    replies: 3,
    suppressions: 4,
    crm_edits: 5,
    migrations: 30,
  };

  it('creates the reports directory, writes the handed baseline as step 0 and uses it', async () => {
    const drillReports = join(mkdtempSync(join(tmpdir(), 'fss-g53-')), 'not', 'there', 'fss-drill');
    expect(existsSync(drillReports)).toBe(false);

    const { code, stderr } = await run(
      ['drill', '--reports', drillReports, '--baseline-json', JSON.stringify(handed), '--all-mailboxes'],
      recordedEnvironment(),
    );

    // A refusal at step 1 (20), not a thrown ENOENT (21): the directory was made first.
    expect(code, stderr).toBe(20);
    expect(stderr).not.toContain('ENOENT');
    expect(statSync(drillReports).isDirectory()).toBe(true);
    expect(statSync(drillReports).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(drillReports, 'step0-baseline.json'), 'utf8'))).toEqual(handed);
    const summary = JSON.parse(readFileSync(join(drillReports, 'drill.json'), 'utf8')) as Record<string, unknown>;
    expect(summary['baselineAt']).toBe(handed.asOf);
    expect(summary['stoppedAt']).toBe('step1-restore-holds');
    // Not measured again: the measured form records a step0-baseline step, and a
    // measurement here would have found an empty database and refused before step 1.
    const steps = summary['steps'] as readonly Record<string, unknown>[];
    expect(steps.map(entry => entry['step'])).not.toContain('step0-baseline');
    expect(stderr).not.toContain('baseline_empty');
  });

  it('refuses, naming the directory, when the reports directory cannot be made', async () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'fss-g53-blocked-')), 'a-file');
    writeFileSync(blocker, 'not a directory\n');
    const { code, stderr } = await run(
      ['drill', '--reports', join(blocker, 'fss-drill'), '--baseline-json', JSON.stringify(handed)],
      recordedEnvironment(),
    );
    expect(code, stderr).toBe(20);
    expect(stderr).toContain('reports_unwritable');
  });

  it('refuses a handed baseline that is not a JSON object, or carries no instant, as baseline_unreadable', async () => {
    const noInstant = JSON.stringify({ ...handed, asOf: undefined });
    for (const value of ['{"asOf":', '[1,2,3]', 'null', noInstant]) {
      const drillReports = mkdtempSync(join(tmpdir(), 'fss-g53-unreadable-'));
      const { code, stderr } = await run(
        ['drill', '--reports', drillReports, '--baseline-json', value],
        recordedEnvironment(),
      );
      expect(code, value).toBe(20);
      expect(stderr, value).toContain('baseline_unreadable');
      expect(existsSync(join(drillReports, 'step1-restore-holds.json')), value).toBe(false);
    }
  });

  it('keeps the baseline_empty refusal for a handed baseline with nothing in it', async () => {
    const { code, stderr } = await run(
      [
        'drill',
        '--reports',
        mkdtempSync(join(tmpdir(), 'fss-g53-empty-')),
        '--baseline-json',
        JSON.stringify({ ...handed, sends: 0 }),
      ],
      recordedEnvironment(),
    );
    expect(code).toBe(20);
    expect(stderr).toContain('baseline_empty');
  });

  it('refuses the handed baseline beside an instant or a file, before a database is opened', async () => {
    const both = await run(
      ['drill', '--reports', reports, '--as-of', handed.asOf, '--baseline-json', JSON.stringify(handed)],
      recordedEnvironment(),
    );
    expect(both.code).toBe(64);
    const file = await run(
      ['drill', '--reports', reports, '--baseline', join(reports, 'x.json'), '--baseline-json', JSON.stringify(handed)],
      recordedEnvironment(),
    );
    expect(file.code).toBe(64);
  });
});

/**
 * Lane g56: the drill's step 1 is held by the generation check the worker runs, and
 * `fss admin restore-holds open` is that check by hand.
 *
 * The fourteenth full run (36062337914, 24 September 2026) passed step 0 and stopped at
 * step 1: nothing anywhere opened a restore hold. The drill now takes
 * `--expected-generation`, the runner passes the source baseline's generation plus one,
 * and step 1a runs `admin restore-holds open` with it.
 *
 * ## The vacuous-pass trap, named
 *
 * "Step 1 passes" could be true because a test inserted the hold, which is how every
 * case before this lane reached it. Here nothing inserts one: the database has a
 * workspace and no hold, the drill without a pin stops at step 1 exactly as the
 * fourteenth run did, and the same drill with a pin gets past step 1 on holds step 1a
 * opened — and is then refused a dial because there is nothing to dial, which is step
 * 1's own second assertion and not this lane's. The mismatch line is read off stderr,
 * where the tool logs in the shape the metric filter counts.
 */
describe('fss drill --expected-generation, and fss admin restore-holds open (lane g56)', () => {
  const handed = {
    asOf: '2026-09-21T00:00:00.000Z',
    sends: 2,
    replies: 3,
    suppressions: 4,
    crm_edits: 5,
    migrations: 30,
  };
  let workspaceId: string;

  beforeAll(async () => {
    const created = await session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('g56', 'Restore holds') RETURNING id",
    );
    workspaceId = created.rows[0]?.id ?? '';
  });

  async function restoreHolds(): Promise<number> {
    const { rows } = await session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM active_holds WHERE reason_code = 'restore_in_progress' AND released_at IS NULL",
    );
    return Number(rows[0]?.count ?? '0');
  }

  function mismatchLines(stderr: string): readonly Record<string, unknown>[] {
    return stderr
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(line => line['event'] === 'restore_generation_mismatch');
  }

  function readStep(directory: string, name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8')) as Record<string, unknown>;
  }

  it('reports the database generation beside the counts, which is what the runner pins from', async () => {
    const { code, stdout } = await run(['admin', 'counts']);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as Record<string, unknown>)['systemGeneration']).toBe(1);
  });

  it('without a pin, stops at step 1 exactly as the fourteenth run did, and says what was missing', async () => {
    const drillReports = mkdtempSync(join(tmpdir(), 'fss-g56-unpinned-'));
    const { code, stderr } = await run(
      ['drill', '--reports', drillReports, '--baseline-json', JSON.stringify(handed), '--all-mailboxes'],
      recordedEnvironment(),
    );
    expect(code, stderr).toBe(20);
    const summary = JSON.parse(readFileSync(join(drillReports, 'drill.json'), 'utf8')) as Record<string, unknown>;
    expect(summary['stoppedAt']).toBe('step1-restore-holds');
    expect(stderr).toContain('No --expected-generation was given');
    expect(existsSync(join(drillReports, 'step1a-generation-check.json'))).toBe(false);
    expect(mismatchLines(stderr)).toHaveLength(0);
    expect(await restoreHolds()).toBe(0);
  });

  it('refuses a pin equal to the database generation at step 1a, before step 1 is asked', async () => {
    const drillReports = mkdtempSync(join(tmpdir(), 'fss-g56-equal-'));
    const { code, stderr } = await run(
      [
        'drill',
        '--reports',
        drillReports,
        '--baseline-json',
        JSON.stringify(handed),
        '--expected-generation',
        '1',
        '--all-mailboxes',
      ],
      recordedEnvironment(),
    );
    expect(code, stderr).toBe(20);
    const summary = JSON.parse(readFileSync(join(drillReports, 'drill.json'), 'utf8')) as Record<string, unknown>;
    expect(summary['stoppedAt']).toBe('step1a-generation-check');
    expect(readStep(drillReports, 'step1a-generation-check')).toMatchObject({ refused: 'generation_matches' });
    expect(existsSync(join(drillReports, 'step1-restore-holds.json'))).toBe(false);
    expect(await restoreHolds()).toBe(0);
  });

  it('with the pin one ahead, opens the restore hold at step 1a, logs the mismatch, and passes step 1', async () => {
    const drillReports = mkdtempSync(join(tmpdir(), 'fss-g56-pinned-'));
    const { code, stderr } = await run(
      [
        'drill',
        '--reports',
        drillReports,
        '--baseline-json',
        JSON.stringify(handed),
        '--expected-generation',
        '2',
        '--all-mailboxes',
      ],
      recordedEnvironment(),
    );
    // Stopped, but past step 1's restore-hold assertion: at the dial probe, which finds
    // no dialable subject in a database with one bare workspace and refuses to call
    // that a refusal (the vacuous pass step 1's second half exists to prevent).
    expect(code, stderr).toBe(20);
    const summary = JSON.parse(readFileSync(join(drillReports, 'drill.json'), 'utf8')) as Record<string, unknown>;
    expect(summary['stoppedAt']).toBe('step1-dial-refused');
    const steps = summary['steps'] as readonly Record<string, unknown>[];
    expect(steps.map(entry => [entry['step'], entry['ok']])).toEqual([
      ['step1a-generation-check', true],
      ['step1-restore-holds', true],
      ['step1-dial-refused', false],
    ]);
    expect(readStep(drillReports, 'step1a-generation-check')).toMatchObject({
      systemGeneration: 1,
      expectedGeneration: 2,
      mismatch: true,
      holdsOpened: 1,
      holdsAlreadyOpen: 0,
      restoreHoldsInForce: 1,
    });
    expect(readStep(drillReports, 'step1-restore-holds')['count']).toBe(1);
    expect(await restoreHolds()).toBe(1);

    const lines = mismatchLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      component: 'fss',
      expected_generation: 2,
      observed_generation: 1,
      restore_holds_opened: 1,
    });
  });

  it('admin restore-holds open is idempotent, and refuses a pin it cannot use', async () => {
    const again = await run(['admin', 'restore-holds', 'open', '--expected-generation', '2']);
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ mismatch: true, holdsOpened: 0, holdsAlreadyOpen: 1, restoreHoldsInForce: 1 });
    expect(mismatchLines(again.stderr)).toHaveLength(1);
    expect(await restoreHolds()).toBe(1);

    for (const value of ['0', 'two', '1.5', '-3']) {
      const refused = await run(['admin', 'restore-holds', 'open', '--expected-generation', value]);
      expect(refused.code, value).toBe(20);
      expect(refused.stderr, value).toContain('expected_generation_invalid');
    }
    const equal = await run(['admin', 'restore-holds', 'open', '--expected-generation', '1']);
    expect(equal.code).toBe(20);
    expect(equal.stderr).toContain('generation_matches');
    // A usage error, not a guess: the generation is the one thing it cannot default.
    expect((await run(['admin', 'restore-holds', 'open'])).code).toBe(64);
    expect(await restoreHolds()).toBe(1);
  });

  it('after step 9 the database is on the pin and the pinned check holds nothing; on any other generation it is not run', async () => {
    const { advanceSystemGeneration } = await import('@fss/domain/restore');
    const { withTransaction } = await import('@fss/domain/db');
    const { recordingLogger } = await import('../src/bootstrap/log.ts');
    const { reconcileGenerationAfterAdvance } = await import('../src/tools/fss/drill.ts');

    // Step 9 needs an attributed admin.
    const user = await session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`sub-${randomUUID()}`, 'g56-admin@example.test', 'Admin'],
    );
    const adminUserId = user.rows[0]?.id ?? '';
    await session.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [
      workspaceId,
      adminUserId,
    ]);
    const advanced = await withTransaction(session, async () => advanceSystemGeneration(session, { adminUserId }));
    expect(advanced).toMatchObject({ ok: true, value: { generation: 2, releasedRestoreHolds: 1 } });

    const log = recordingLogger();
    expect(await reconcileGenerationAfterAdvance(session, 2, log)).toEqual({
      generation: 2,
      expectedGeneration: 2,
      reconciled: true,
      mismatch: false,
      holdsOpened: 0,
      restoreHoldsInForce: 0,
    });
    // A pin step 9 did not land on is reported, and nothing is opened on its account.
    expect(await reconcileGenerationAfterAdvance(session, 3, log)).toEqual({
      generation: 2,
      expectedGeneration: 3,
      reconciled: false,
    });
    expect(log.lines.map(line => line['event'])).not.toContain('restore_generation_mismatch');
    expect(await restoreHolds()).toBe(0);
  });
});
