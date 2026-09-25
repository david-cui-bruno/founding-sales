import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import {
  ECS_METADATA_VARIABLE,
  IMAGE_DIGEST_VARIABLE,
  digestFromContainerMetadata,
  discoverImageDigest,
  putReleaseRecord,
  readReleaseRecord,
  releaseRecordBinding,
  type StoredReleaseRecord,
} from '../../release/index.ts';
import {
  FIXTURE_API_DIGEST,
  FIXTURE_WORKER_DIGEST,
  fixtureDigest,
  fixtureReleaseRecord,
} from './support/releaseRecords.ts';

/**
 * The release records and the rule that reads them (lane g71; specification 16.2,
 * Appendix G 42).
 *
 * ## The vacuous-pass trap, named
 *
 * A binding that always refused would pass every refusal case here and make sending
 * impossible, which is safe and useless; one that always accepted would pass the
 * positive control and make the rule decorative. So each refusal is paired with the
 * passing case that differs from it in exactly one fact, and the mutation check
 * removes the suite and digest comparisons and requires the settings and gate suites
 * to go red.
 */

describe('storing a release record', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('stores the record the rehearsal wrote, from its JSON text, and reads it back', async () => {
    const record = fixtureReleaseRecord('fss-rh-fixture-2026-09-25T07:20:44Z');
    const stored = await putReleaseRecord({ db: database.session }, JSON.stringify(record, null, 2));
    expect(stored).toMatchObject({ ok: true, value: { outcome: 'created' } });

    const read = await readReleaseRecord({ db: database.session }, record.releaseGateReference);
    expect(read).toMatchObject({
      reference: record.releaseGateReference,
      suite: 'pass',
      apiDigest: FIXTURE_API_DIGEST,
      workerDigest: FIXTURE_WORKER_DIGEST,
      desktopCommitStamp: record.artifacts.desktopCommitStamp,
      enablesSending: false,
      recordedAt: '2026-09-25T07:20:44.000Z',
    });
    expect(read?.record).toEqual(record);
  });

  it('answers existing for the same record again, however it is formatted', async () => {
    const record = fixtureReleaseRecord('fss-rh-fixture-same');
    expect(await putReleaseRecord({ db: database.session }, record)).toMatchObject({
      ok: true,
      value: { outcome: 'created' },
    });
    // Different key order and whitespace; jsonb equality is what decides.
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(record).reverse()), null, 4);
    expect(await putReleaseRecord({ db: database.session }, reordered)).toMatchObject({
      ok: true,
      value: { outcome: 'existing' },
    });
    const count = await database.session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM release_records WHERE reference = 'fss-rh-fixture-same'",
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('refuses a different record under a reference that is taken, and keeps the first', async () => {
    const reference = 'fss-rh-fixture-conflict';
    await putReleaseRecord({ db: database.session }, fixtureReleaseRecord(reference));
    const other = await putReleaseRecord(
      { db: database.session },
      fixtureReleaseRecord(reference, { worker: fixtureDigest('e') }),
    );
    expect(other).toMatchObject({ ok: false, reason: 'release_record_conflict' });
    expect((await readReleaseRecord({ db: database.session }, reference))?.workerDigest).toBe(FIXTURE_WORKER_DIGEST);
  });

  it('refuses what the contract refuses, and names the field', async () => {
    const reference = 'fss-rh-fixture-invalid';
    const tagged = { ...fixtureReleaseRecord(reference), artifacts: { api: 'latest', worker: FIXTURE_WORKER_DIGEST, desktopCommitStamp: 'x' } };
    const refused = await putReleaseRecord({ db: database.session }, tagged);
    expect(refused).toMatchObject({ ok: false, reason: 'release_record_invalid' });
    if (!refused.ok) expect(refused.detail).toContain('artifacts.api');

    expect(await putReleaseRecord({ db: database.session }, '{ not json')).toMatchObject({
      ok: false,
      reason: 'release_record_invalid',
    });
    expect(
      await putReleaseRecord({ db: database.session }, { ...fixtureReleaseRecord(reference), extra: true }),
    ).toMatchObject({ ok: false, reason: 'release_record_invalid' });
    expect(await readReleaseRecord({ db: database.session }, reference)).toBeNull();
  });

  it('is append-only for the runtime role: no UPDATE, no DELETE, no TRUNCATE', async () => {
    const reference = 'fss-rh-fixture-append-only';
    const runtime = await database.appRuntimeSession();
    // The runtime role can put one — that is how `fss admin release-record put` runs.
    expect(await putReleaseRecord({ db: runtime }, fixtureReleaseRecord(reference))).toMatchObject({ ok: true });
    await expect(
      runtime.query("UPDATE release_records SET worker_digest = $1 WHERE reference = $2", [fixtureDigest('e'), reference]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('DELETE FROM release_records')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('TRUNCATE release_records')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('whether a record binds to the image that is asking', () => {
  const stored = (suite = 'pass'): StoredReleaseRecord => ({
    reference: 'fss-rh-fixture-binding',
    recordedAt: '2026-09-25T07:20:44.000Z',
    suite,
    apiDigest: FIXTURE_API_DIGEST,
    workerDigest: FIXTURE_WORKER_DIGEST,
    desktopCommitStamp: 'd'.repeat(40),
    enablesSending: false,
    record: fixtureReleaseRecord('fss-rh-fixture-binding', { suite }),
    putAt: '2026-09-25T08:00:00.000Z',
  });

  it('binds each side to its own digest, which is the positive control', () => {
    expect(releaseRecordBinding(stored(), 'api', FIXTURE_API_DIGEST)).toMatchObject({ ok: true });
    expect(releaseRecordBinding(stored(), 'worker', FIXTURE_WORKER_DIGEST)).toMatchObject({ ok: true });
  });

  it('refuses each side the other side’s digest, and any other', () => {
    expect(releaseRecordBinding(stored(), 'api', FIXTURE_WORKER_DIGEST)).toEqual({
      ok: false,
      reason: 'release_record_digest_mismatch',
    });
    expect(releaseRecordBinding(stored(), 'worker', FIXTURE_API_DIGEST)).toEqual({
      ok: false,
      reason: 'release_record_digest_mismatch',
    });
    expect(releaseRecordBinding(stored(), 'worker', fixtureDigest('e'))).toEqual({
      ok: false,
      reason: 'release_record_digest_mismatch',
    });
  });

  it('refuses a record nobody stored, and one that did not pass', () => {
    expect(releaseRecordBinding(null, 'api', FIXTURE_API_DIGEST)).toEqual({ ok: false, reason: 'release_record_unknown' });
    expect(releaseRecordBinding(stored('fail'), 'api', FIXTURE_API_DIGEST)).toEqual({
      ok: false,
      reason: 'release_record_not_passing',
    });
  });

  it('refuses under an identity the process could not determine, whatever the record says', () => {
    for (const running of ['unknown', '', undefined, null, 'latest', `${FIXTURE_API_DIGEST} `]) {
      expect(releaseRecordBinding(stored(), 'api', running), String(running)).toEqual({
        ok: false,
        reason: 'release_record_identity_unknown',
      });
    }
  });
});

describe('which image this process is running', () => {
  let server: Server;
  let base: string;
  /** What the fake endpoint answers next, per path. */
  const answers = new Map<string, { status: number; body: unknown }>();
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      hits.push(path);
      const answer = answers.get(path) ?? { status: 404, body: { error: 'no such path' } };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v4/fixture-container`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const registry = '123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-fixture-api';

  it('reads the pinned digest from the container endpoint’s Image, not from /task', async () => {
    hits.length = 0;
    answers.set('/v4/fixture-container', {
      status: 200,
      body: { Name: 'api', Image: `${registry}@${FIXTURE_API_DIGEST}`, ImageID: fixtureDigest('9') },
    });
    const identity = await discoverImageDigest({ [ECS_METADATA_VARIABLE]: base });
    expect(identity).toEqual({ digest: FIXTURE_API_DIGEST, source: 'ecs_metadata_image', detail: null });
    expect(hits).toEqual(['/v4/fixture-container']);
  });

  it('falls back to ImageID only when the reference carries no digest', async () => {
    answers.set('/v4/fixture-container', {
      status: 200,
      body: { Name: 'api', Image: `${registry}:latest`, ImageID: fixtureDigest('9') },
    });
    expect(await discoverImageDigest({ [ECS_METADATA_VARIABLE]: base })).toEqual({
      digest: fixtureDigest('9'),
      source: 'ecs_metadata_image_id',
      detail: null,
    });
  });

  it('ignores FSS_IMAGE_DIGEST inside ECS, even when the endpoint fails', async () => {
    answers.set('/v4/fixture-container', {
      status: 200,
      body: { Name: 'api', Image: `${registry}@${FIXTURE_API_DIGEST}` },
    });
    const claimed = await discoverImageDigest({
      [ECS_METADATA_VARIABLE]: base,
      [IMAGE_DIGEST_VARIABLE]: fixtureDigest('e'),
    });
    expect(claimed).toEqual({
      digest: FIXTURE_API_DIGEST,
      source: 'ecs_metadata_image',
      detail: 'override_ignored_inside_ecs',
    });

    answers.set('/v4/fixture-container', { status: 500, body: {} });
    const failed = await discoverImageDigest(
      { [ECS_METADATA_VARIABLE]: base, [IMAGE_DIGEST_VARIABLE]: fixtureDigest('e') },
      { retryDelayMilliseconds: 1 },
    );
    expect(failed).toEqual({ digest: 'unknown', source: 'unknown', detail: 'metadata_status_500' });
  });

  it('is unknown when the endpoint cannot be reached or answers without a digest', async () => {
    const unreachable = await discoverImageDigest(
      { [ECS_METADATA_VARIABLE]: 'http://127.0.0.1:1/v4/nothing-listens-here' },
      { retryDelayMilliseconds: 1, timeoutMilliseconds: 500 },
    );
    expect(unreachable).toEqual({ digest: 'unknown', source: 'unknown', detail: 'metadata_unreachable' });

    answers.set('/v4/fixture-container', { status: 200, body: { Name: 'api', Image: `${registry}:latest` } });
    expect(await discoverImageDigest({ [ECS_METADATA_VARIABLE]: base })).toEqual({
      digest: 'unknown',
      source: 'unknown',
      detail: 'metadata_has_no_digest',
    });
  });

  it('retries a failed answer before giving up', async () => {
    let calls = 0;
    const identity = await discoverImageDigest(
      { [ECS_METADATA_VARIABLE]: base },
      {
        retryDelayMilliseconds: 1,
        fetch: async () => {
          calls += 1;
          if (calls < 3) throw new Error('connection reset');
          return await Promise.resolve({
            ok: true,
            status: 200,
            json: async () => await Promise.resolve({ Image: `${registry}@${FIXTURE_WORKER_DIGEST}` }),
          });
        },
      },
    );
    expect(calls).toBe(3);
    expect(identity.digest).toBe(FIXTURE_WORKER_DIGEST);
  });

  it('outside ECS takes FSS_IMAGE_DIGEST when it is a digest, and is unknown otherwise', async () => {
    expect(await discoverImageDigest({ [IMAGE_DIGEST_VARIABLE]: FIXTURE_WORKER_DIGEST })).toEqual({
      digest: FIXTURE_WORKER_DIGEST,
      source: 'environment',
      detail: null,
    });
    expect(await discoverImageDigest({ [IMAGE_DIGEST_VARIABLE]: 'latest' })).toEqual({
      digest: 'unknown',
      source: 'unknown',
      detail: 'override_not_a_digest',
    });
    expect(await discoverImageDigest({})).toEqual({
      digest: 'unknown',
      source: 'unknown',
      detail: 'not_in_ecs_and_no_override',
    });
  });

  it('reads nothing it does not understand as a digest', () => {
    for (const metadata of [null, [], 'text', { Image: 42 }, { ImageID: 'sha256:short' }, {}]) {
      expect(digestFromContainerMetadata(metadata), JSON.stringify(metadata)).toBeNull();
    }
  });
});
