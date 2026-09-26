import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RELEASE_RECORD_SCHEMA_ID, ciGateReleaseReference } from '@fss/contracts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession } from '@fss/domain/db/testing/testDatabase.ts';
import { main } from '../src/tools/fss.ts';
import { COMMAND_DEPENDENCIES, parseFssCommand } from '../src/tools/fss/commands.ts';

/**
 * `fss admin release-record put` and `show` (lane g71).
 *
 * `deploy.sh release --release-record <file>` runs the put on the operations task, so the
 * record the CI gate wrote (`record.sh from-ci`) is in the database for the
 * admin's attestation to name. What is asserted here is the command line: the file and
 * base64 forms, the JSON on stdout, the report file, the exit codes, and the row.
 *
 * ## The vacuous-pass trap, named
 *
 * A put that printed `created` without writing would pass a test that read only
 * stdout, so every accepted case also reads the row, and every refusal is paired with
 * a count that did not move. The data is fictional: digests of repeated letters and gate
 * runs nobody ran.
 */

let adminUrl: string;
let databaseName: string;
let databaseUrl: string;
let client: pg.Client;
let session: SessionQueryable;
let directory: string;

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

const COMMIT = 'c'.repeat(40);

/** The record `record.sh from-ci` writes for gate run `runId`. */
const record = (runId: string, worker = digest('b')): Record<string, unknown> => ({
  schema: RELEASE_RECORD_SCHEMA_ID,
  source: 'ci-gate',
  releaseGateReference: ciGateReleaseReference(runId, COMMIT),
  recordedAt: '2026-09-25T21:40:12Z',
  suite: 'pass',
  commit: COMMIT,
  gateRunId: runId,
  gateRunUrl: `https://github.com/example-owner/example-repo/actions/runs/${runId}`,
  imagesRunId: '1',
  artifacts: { api: digest('a'), worker, desktopCommitStamp: COMMIT },
  enablesSending: false,
});
const referenceOf = (runId: string): string => ciGateReleaseReference(runId, COMMIT);

async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
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
    const code = await main(argv, { DATABASE_URL: databaseUrl, FSS_MIGRATION_DATABASE_URL: databaseUrl });
    return { code, stdout: printed.join(''), stderr: logged.join('') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const rows = async (reference: string): Promise<number> => {
  const { rows: found } = await session.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM release_records WHERE reference = $1',
    [reference],
  );
  return Number(found[0]?.count ?? '0');
};

beforeAll(async () => {
  adminUrl = process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '';
  expect(adminUrl.length, 'the embedded cluster URL is what globalSetup leaves').toBeGreaterThan(0);
  databaseName = `fss_release_${randomUUID().replaceAll('-', '')}`;
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
  directory = mkdtempSync(join(tmpdir(), 'fss-release-record-'));
  const migrated = await run(['migrate']);
  expect(migrated.code, 'the release-record tests need a migrated database').toBe(0);
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

describe('fss admin release-record put', () => {
  it('stores the record from the file the CI gate wrote, and says so on stdout and in the report', async () => {
    const reference = referenceOf('41000000011');
    const file = join(directory, 'release-record.json');
    writeFileSync(file, `${JSON.stringify(record('41000000011'), null, 2)}\n`);
    const report = join(directory, 'put.json');

    const put = await run(['admin', 'release-record', 'put', '--json', file, '--report', report]);
    expect(put.code, put.stderr).toBe(0);
    const answer = JSON.parse(put.stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({
      outcome: 'created',
      reference,
      suite: 'pass',
      apiDigest: digest('a'),
      workerDigest: digest('b'),
      enablesSending: false,
    });
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual(answer);
    expect(await rows(reference)).toBe(1);

    // Again, as the base64 argument deploy.sh release hands a one-off task: same record.
    const encoded = Buffer.from(readFileSync(file)).toString('base64');
    const again = await run(['admin', 'release-record', 'put', '--json-base64', encoded]);
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ outcome: 'existing', reference });
    expect(await rows(reference)).toBe(1);
  });

  it('stores a record from the CI gate as deploy.sh release hands it over, and says it is ci-gate', async () => {
    // Lane g96: the shape record.sh from-ci writes, which carries no drill evidence.
    const commit = 'e'.repeat(40);
    const reference = `ci-gate-41000000001-${commit.slice(0, 12)}`;
    const ciRecord = {
      schema: RELEASE_RECORD_SCHEMA_ID,
      source: 'ci-gate',
      releaseGateReference: reference,
      recordedAt: '2026-09-25T21:40:12Z',
      suite: 'pass',
      commit,
      gateRunId: '41000000001',
      gateRunUrl: 'https://github.com/example-owner/example-repo/actions/runs/41000000001',
      imagesRunId: '41000000002',
      artifacts: { api: digest('a'), worker: digest('b'), desktopCommitStamp: commit },
      enablesSending: true,
    };
    const encoded = Buffer.from(`${JSON.stringify(ciRecord, null, 2)}\n`).toString('base64');
    const put = await run(['admin', 'release-record', 'put', '--json-base64', encoded]);
    expect(put.code, put.stderr).toBe(0);
    expect(JSON.parse(put.stdout)).toMatchObject({
      outcome: 'created',
      reference,
      source: 'ci-gate',
      suite: 'pass',
      apiDigest: digest('a'),
      workerDigest: digest('b'),
      desktopCommitStamp: commit,
      enablesSending: true,
    });
    expect(await rows(reference)).toBe(1);

    const shown = await run(['admin', 'release-record', 'show', '--reference', reference]);
    expect(JSON.parse(shown.stdout)).toMatchObject({ source: 'ci-gate', record: ciRecord });
  });

  it('refuses a different record under a reference already stored, with exit 20', async () => {
    const reference = referenceOf('41000000012');
    const first = join(directory, 'first.json');
    const second = join(directory, 'second.json');
    writeFileSync(first, JSON.stringify(record('41000000012')));
    writeFileSync(second, JSON.stringify(record('41000000012', digest('e'))));
    expect((await run(['admin', 'release-record', 'put', '--json', first])).code).toBe(0);

    const refused = await run(['admin', 'release-record', 'put', '--json', second]);
    expect(refused.code).toBe(20);
    expect(refused.stderr).toContain('release_record_conflict');
    expect(refused.stdout).toBe('');
    const { rows: kept } = await session.query<{ worker_digest: string }>(
      'SELECT worker_digest FROM release_records WHERE reference = $1',
      [reference],
    );
    expect(kept.map(row => row.worker_digest)).toEqual([digest('b')]);
  });

  it('refuses a record the contract refuses, a file it cannot read and base64 that is not', async () => {
    const reference = referenceOf('41000000013');
    const tagged = join(directory, 'tagged.json');
    writeFileSync(tagged, JSON.stringify({ ...record('41000000013'), artifacts: { api: 'latest', worker: digest('b'), desktopCommitStamp: COMMIT } }));
    const invalid = await run(['admin', 'release-record', 'put', '--json', tagged]);
    expect(invalid.code).toBe(20);
    expect(invalid.stderr).toContain('release_record_invalid');
    expect(invalid.stderr).toContain('artifacts.api');

    // The record a full rehearsal wrote, before that mode was deleted (lane W3-S8).
    const rehearsal = join(directory, 'rehearsal.json');
    const { source: _source, commit: _commit, gateRunId: _run, gateRunUrl: _url, imagesRunId: _images, ...rest } = record('41000000013');
    writeFileSync(rehearsal, JSON.stringify({ ...rest, rehearsalPrefix: 'fss-rh-fixture', rehearsalScenarios: { '11': 'result=pass' } }));
    const refusedRehearsal = await run(['admin', 'release-record', 'put', '--json', rehearsal]);
    expect(refusedRehearsal.code).toBe(20);
    expect(refusedRehearsal.stderr).toContain('release_record_invalid');

    const missing = await run(['admin', 'release-record', 'put', '--json', join(directory, 'nothing-here.json')]);
    expect(missing.code).toBe(20);
    expect(missing.stderr).toContain('release_record_unreadable');

    const garbled = await run(['admin', 'release-record', 'put', '--json-base64', 'not*base64']);
    expect(garbled.code).toBe(20);
    expect(garbled.stderr).toContain('release_record_unreadable');
    expect(await rows(reference)).toBe(0);
  });

  it('takes exactly one of --json and --json-base64, and touches only the database', () => {
    expect(parseFssCommand(['admin', 'release-record', 'put'])).toMatchObject({ ok: false, reason: 'selection_missing' });
    expect(
      parseFssCommand(['admin', 'release-record', 'put', '--json', '/tmp/a.json', '--json-base64', 'e30=']),
    ).toMatchObject({ ok: false, reason: 'selection_missing' });
    expect(COMMAND_DEPENDENCIES['release-record put']).toBe('database');
    expect(COMMAND_DEPENDENCIES['release-record show']).toBe('database');
  });
});

describe('fss admin release-record show', () => {
  it('reads back a stored record with the digests the two rules compare', async () => {
    const reference = referenceOf('41000000014');
    const file = join(directory, 'show.json');
    writeFileSync(file, JSON.stringify(record('41000000014')));
    expect((await run(['admin', 'release-record', 'put', '--json', file])).code).toBe(0);

    const shown = await run(['admin', 'release-record', 'show', '--reference', reference]);
    expect(shown.code, shown.stderr).toBe(0);
    const answer = JSON.parse(shown.stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({
      reference,
      source: 'ci-gate',
      apiDigest: digest('a'),
      workerDigest: digest('b'),
      suite: 'pass',
    });
    expect(answer['record']).toEqual(record('41000000014'));
  });

  it('names a record a full rehearsal stored before lane W3-S8 a rehearsal’s', async () => {
    const reference = 'fss-rh-fixture-2026-09-25T07:20:44Z';
    const stored = {
      schema: RELEASE_RECORD_SCHEMA_ID,
      releaseGateReference: reference,
      rehearsalPrefix: 'fss-rh-fixture',
      recordedAt: '2026-09-25T07:20:44Z',
      suite: 'pass',
      artifacts: { api: digest('a'), worker: digest('b'), desktopCommitStamp: COMMIT },
      rehearsalScenarios: { '11': 'prefix=fss-rh-fixture result=pass' },
      enablesSending: false,
    };
    await session.query(
      `INSERT INTO release_records (reference, recorded_at, suite, api_digest, worker_digest, desktop_commit_stamp, enables_sending, record)
       VALUES ($1, TIMESTAMPTZ '2026-09-25T07:20:44Z', 'pass', $2, $3, $4, false, $5::jsonb)`,
      [reference, digest('a'), digest('b'), COMMIT, JSON.stringify(stored)],
    );
    const shown = await run(['admin', 'release-record', 'show', '--reference', reference]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ reference, source: 'rehearsal', record: stored });
  });

  it('refuses a reference nobody stored, and a bare word in place of --reference', async () => {
    const unknown = await run(['admin', 'release-record', 'show', '--reference', 'fss-rh-nobody-ran-this']);
    expect(unknown.code).toBe(20);
    expect(unknown.stderr).toContain('release_record_unknown');
    expect(parseFssCommand(['admin', 'release-record', 'show', 'fss-rh-fixture-show'])).toMatchObject({
      ok: false,
      reason: 'command_unknown',
    });
  });
});
