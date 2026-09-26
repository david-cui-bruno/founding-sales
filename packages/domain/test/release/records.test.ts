import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { CI_GATE_MAIN_POLICY } from '@fss/contracts';
import {
  ECS_METADATA_VARIABLE,
  IMAGE_DIGEST_VARIABLE,
  digestFromContainerMetadata,
  discoverImageDigest,
} from '../../release/identity.ts';
import {
  bindReleaseAttestation,
  putReleaseRecord,
  readCiGateRecordFor,
  readReleaseRecord,
  releasePolicyBinding,
  releaseRecordBinding,
  type StoredReleaseRecord,
} from '../../release/records.ts';
import {
  FIXTURE_API_DIGEST,
  FIXTURE_CI_COMMIT,
  FIXTURE_WORKER_DIGEST,
  fixtureCiGateRecord,
  fixtureDigest,
  fixtureReleaseRecord,
  storeFixtureRecord,
} from './support/releaseRecords.ts';

/** The two deployments a binding tells apart: production binds only the CI gate's records. */
const PRODUCTION = { production: true } as const;
const REHEARSAL_STACK = { production: false } as const;

/**
 * The release records and the rule that reads them (lane g71; specification 16.2,
 * Appendix G 42).
 *
 * ## The vacuous-pass trap, named
 *
 * A binding that always refused would pass every refusal case here and make sending
 * impossible, which is safe and useless; one that always accepted would pass the
 * positive control and make the rule decorative. So each refusal is paired with the
 * passing case that differs from it in exactly one fact, so removing the suite and
 * digest comparisons turns the settings and gate suites red.
 */

describe('storing a release record', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('refuses the record a full rehearsal wrote, now that the mode is gone, and still reads one stored before', async () => {
    const reference = 'fss-rh-fixture-2026-09-25T07:20:44Z';
    const refused = await putReleaseRecord({ db: database.session }, JSON.stringify(fixtureReleaseRecord(reference), null, 2));
    expect(refused).toMatchObject({ ok: false, reason: 'release_record_invalid' });
    expect(await readReleaseRecord({ db: database.session }, reference)).toBeNull();

    await storeFixtureRecord(database.session, reference);
    const read = await readReleaseRecord({ db: database.session }, reference);
    expect(read).toMatchObject({
      reference,
      suite: 'pass',
      apiDigest: FIXTURE_API_DIGEST,
      workerDigest: FIXTURE_WORKER_DIGEST,
      desktopCommitStamp: 'd'.repeat(40),
      enablesSending: false,
      recordedAt: '2026-09-25T07:20:44.000Z',
    });
    expect(read?.record).toEqual(fixtureReleaseRecord(reference));
  });

  it('answers existing for the same record again, however it is formatted', async () => {
    const record = fixtureCiGateRecord('41000000101');
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
      'SELECT count(*)::text AS count FROM release_records WHERE reference = $1',
      [record.releaseGateReference],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('refuses a different record under a reference that is taken, and keeps the first', async () => {
    const first = fixtureCiGateRecord('41000000102');
    await putReleaseRecord({ db: database.session }, first);
    const other = await putReleaseRecord(
      { db: database.session },
      fixtureCiGateRecord('41000000102', { worker: fixtureDigest('e') }),
    );
    expect(other).toMatchObject({ ok: false, reason: 'release_record_conflict' });
    expect((await readReleaseRecord({ db: database.session }, first.releaseGateReference))?.workerDigest).toBe(
      FIXTURE_WORKER_DIGEST,
    );
  });

  it('refuses what the contract refuses, and names the field', async () => {
    const valid = fixtureCiGateRecord('41000000103');
    const reference = valid.releaseGateReference;
    const tagged = { ...valid, artifacts: { ...valid.artifacts, api: 'latest' } };
    const refused = await putReleaseRecord({ db: database.session }, tagged);
    expect(refused).toMatchObject({ ok: false, reason: 'release_record_invalid' });
    if (!refused.ok) expect(refused.detail).toContain('artifacts.api');

    expect(await putReleaseRecord({ db: database.session }, '{ not json')).toMatchObject({
      ok: false,
      reason: 'release_record_invalid',
    });
    expect(await putReleaseRecord({ db: database.session }, { ...valid, extra: true })).toMatchObject({
      ok: false,
      reason: 'release_record_invalid',
    });
    expect(await readReleaseRecord({ db: database.session }, reference)).toBeNull();
  });

  it('stores a record from the CI gate, which carries no drill evidence, and binds both sides to it', async () => {
    // Lane g96. The row's columns are the same five, and the rule reads only them.
    const record = fixtureCiGateRecord('41000000001');
    const stored = await putReleaseRecord({ db: database.session }, JSON.stringify(record, null, 2));
    expect(stored).toMatchObject({ ok: true, value: { outcome: 'created' } });
    const read = await readReleaseRecord({ db: database.session }, record.releaseGateReference);
    expect(read).toMatchObject({
      reference: `ci-gate-41000000001-${FIXTURE_CI_COMMIT.slice(0, 12)}`,
      suite: 'pass',
      apiDigest: FIXTURE_API_DIGEST,
      workerDigest: FIXTURE_WORKER_DIGEST,
      desktopCommitStamp: FIXTURE_CI_COMMIT,
      enablesSending: true,
    });
    expect(read?.record).toEqual(record);
    expect(releaseRecordBinding(read, 'api', FIXTURE_API_DIGEST, PRODUCTION)).toMatchObject({ ok: true });
    expect(releaseRecordBinding(read, 'worker', FIXTURE_WORKER_DIGEST, PRODUCTION)).toMatchObject({ ok: true });
    expect(releaseRecordBinding(read, 'worker', fixtureDigest('e'), PRODUCTION)).toEqual({
      ok: false,
      reason: 'release_record_digest_mismatch',
    });

    // Building it again from the same run is the same record: `existing`, not a conflict.
    expect(await putReleaseRecord({ db: database.session }, fixtureCiGateRecord('41000000001'))).toMatchObject({
      ok: true,
      value: { outcome: 'existing' },
    });
  });

  it('refuses a ci-gate record that claims drill evidence', async () => {
    const claiming = { ...fixtureCiGateRecord('41000000005'), rehearsalPrefix: 'fss-rh-fixture' };
    expect(await putReleaseRecord({ db: database.session }, claiming)).toMatchObject({
      ok: false,
      reason: 'release_record_invalid',
    });
    expect(await readReleaseRecord({ db: database.session }, claiming.releaseGateReference)).toBeNull();
  });

  it('is append-only for the runtime role: no UPDATE, no DELETE, no TRUNCATE', async () => {
    const record = fixtureCiGateRecord('41000000104');
    const reference = record.releaseGateReference;
    const runtime = await database.appRuntimeSession();
    // The runtime role can put one — that is how `fss admin release-record put` runs.
    expect(await putReleaseRecord({ db: runtime }, record)).toMatchObject({ ok: true });
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
    expect(releaseRecordBinding(stored(), 'api', FIXTURE_API_DIGEST, REHEARSAL_STACK)).toMatchObject({ ok: true });
    expect(releaseRecordBinding(stored(), 'worker', FIXTURE_WORKER_DIGEST, REHEARSAL_STACK)).toMatchObject({ ok: true });
  });

  it('refuses each side the other side’s digest, and any other', () => {
    expect(releaseRecordBinding(stored(), 'api', FIXTURE_WORKER_DIGEST, REHEARSAL_STACK)).toEqual({
      ok: false,
      reason: 'release_record_digest_mismatch',
    });
    expect(releaseRecordBinding(stored(), 'worker', FIXTURE_API_DIGEST, REHEARSAL_STACK)).toEqual({
      ok: false,
      reason: 'release_record_digest_mismatch',
    });
    expect(releaseRecordBinding(stored(), 'worker', fixtureDigest('e'), REHEARSAL_STACK)).toEqual({
      ok: false,
      reason: 'release_record_digest_mismatch',
    });
  });

  it('refuses a record nobody stored, and one that did not pass', () => {
    expect(releaseRecordBinding(null, 'api', FIXTURE_API_DIGEST, REHEARSAL_STACK)).toEqual({
      ok: false,
      reason: 'release_record_unknown',
    });
    expect(releaseRecordBinding(stored('fail'), 'api', FIXTURE_API_DIGEST, REHEARSAL_STACK)).toEqual({
      ok: false,
      reason: 'release_record_not_passing',
    });
  });

  it('refuses under an identity the process could not determine, whatever the record says', () => {
    for (const running of ['unknown', '', undefined, null, 'latest', `${FIXTURE_API_DIGEST} `]) {
      expect(releaseRecordBinding(stored(), 'api', running, REHEARSAL_STACK), String(running)).toEqual({
        ok: false,
        reason: 'release_record_identity_unknown',
      });
    }
  });
});

/**
 * Lane g100: the attestation may name the release process, `ci-gate:main`, rather than
 * one record, so an automatic deploy that puts its ci-gate record keeps sending on. Each
 * refusal differs from the positive control in one fact.
 */
describe('the process attestation, ci-gate:main', () => {
  const ciGate = (suite = 'pass'): StoredReleaseRecord => {
    const record = fixtureCiGateRecord('41000000201', { suite });
    return {
      reference: record.releaseGateReference,
      recordedAt: '2026-09-25T21:40:12.000Z',
      suite,
      apiDigest: FIXTURE_API_DIGEST,
      workerDigest: FIXTURE_WORKER_DIGEST,
      desktopCommitStamp: FIXTURE_CI_COMMIT,
      enablesSending: true,
      record,
      putAt: '2026-09-25T22:00:00.000Z',
    };
  };
  const rehearsal: StoredReleaseRecord = {
    reference: 'fss-rh-fixture-policy',
    recordedAt: '2026-09-25T07:20:44.000Z',
    suite: 'pass',
    apiDigest: FIXTURE_API_DIGEST,
    workerDigest: FIXTURE_WORKER_DIGEST,
    desktopCommitStamp: 'd'.repeat(40),
    enablesSending: false,
    record: fixtureReleaseRecord('fss-rh-fixture-policy'),
    putAt: '2026-09-25T08:00:00.000Z',
  };

  it('admits a passing ci-gate record for each side’s own digest, and says the policy admitted it', () => {
    expect(releasePolicyBinding(ciGate(), 'worker', FIXTURE_WORKER_DIGEST)).toEqual({
      ok: true,
      record: ciGate(),
      admittedBy: CI_GATE_MAIN_POLICY,
    });
    expect(releasePolicyBinding(ciGate(), 'api', FIXTURE_API_DIGEST)).toMatchObject({ ok: true });
    // A named reference says so too, so the audit line can tell the two apart.
    expect(releaseRecordBinding(ciGate(), 'worker', FIXTURE_WORKER_DIGEST, PRODUCTION)).toMatchObject({
      ok: true,
      admittedBy: 'reference',
    });
  });

  it('refuses a rehearsal record under the policy, although it names this digest and passed', () => {
    expect(releasePolicyBinding(rehearsal, 'worker', FIXTURE_WORKER_DIGEST)).toEqual({
      ok: false,
      reason: 'release_record_unknown',
    });
    // The same record binds under its own reference, outside production only.
    expect(releaseRecordBinding(rehearsal, 'worker', FIXTURE_WORKER_DIGEST, REHEARSAL_STACK)).toMatchObject({ ok: true });
    expect(releaseRecordBinding(rehearsal, 'worker', FIXTURE_WORKER_DIGEST, PRODUCTION)).toEqual({
      ok: false,
      reason: 'release_record_unknown',
    });
  });

  it('refuses no record, a failed suite, another digest and an unknown identity', () => {
    expect(releasePolicyBinding(null, 'worker', FIXTURE_WORKER_DIGEST)).toEqual({ ok: false, reason: 'release_record_unknown' });
    expect(releasePolicyBinding(ciGate('fail'), 'worker', FIXTURE_WORKER_DIGEST)).toEqual({
      ok: false,
      reason: 'release_record_not_passing',
    });
    expect(releasePolicyBinding(ciGate(), 'worker', fixtureDigest('e'))).toEqual({
      ok: false,
      reason: 'release_record_digest_mismatch',
    });
    for (const running of ['unknown', '', undefined, null]) {
      expect(releasePolicyBinding(ciGate(), 'worker', running), String(running)).toEqual({
        ok: false,
        reason: 'release_record_identity_unknown',
      });
    }
  });

  describe('against stored records', () => {
    let database: TestDatabase;
    const RUNNING = fixtureDigest('3');
    const REHEARSED_ONLY = fixtureDigest('4');
    let reference = '';

    beforeAll(async () => {
      database = await createTestDatabase();
      // The worker image the CI deploy just rolled, and the record it put for it.
      const record = fixtureCiGateRecord('41000000211', { worker: RUNNING });
      expect(await putReleaseRecord({ db: database.session }, record)).toMatchObject({ ok: true });
      reference = record.releaseGateReference;
      // An older gate run of the same worker image whose suite failed: never preferred.
      expect(
        await putReleaseRecord({ db: database.session }, { ...fixtureCiGateRecord('41000000210', { worker: RUNNING, suite: 'fail' }), recordedAt: '2026-09-26T00:00:00Z' }),
      ).toMatchObject({ ok: true });
      // A worker image only a rehearsal certified, in a row stored before lane W3-S8.
      await storeFixtureRecord(database.session, 'fss-rh-fixture-policy-only', { worker: REHEARSED_ONLY });
    });

    afterAll(async () => {
      await database.drop();
    });

    it('is a name no record may carry, so the policy never means one stored row', async () => {
      const named = await putReleaseRecord({ db: database.session }, {
        ...fixtureCiGateRecord('41000000212'),
        releaseGateReference: CI_GATE_MAIN_POLICY,
      });
      expect(named).toMatchObject({ ok: false, reason: 'release_record_invalid' });
      expect(await readReleaseRecord({ db: database.session }, CI_GATE_MAIN_POLICY)).toBeNull();
    });

    it('finds the passing ci-gate record for the running worker, and binds under the policy', async () => {
      expect((await readCiGateRecordFor({ db: database.session }, 'worker', RUNNING))?.reference).toBe(reference);
      expect(await bindReleaseAttestation({ db: database.session }, CI_GATE_MAIN_POLICY, 'worker', RUNNING, PRODUCTION)).toMatchObject({
        ok: true,
        admittedBy: CI_GATE_MAIN_POLICY,
        record: { reference, workerDigest: RUNNING },
      });
    });

    it('holds a worker no ci-gate record names, including one only a rehearsal record names', async () => {
      expect(
        await bindReleaseAttestation({ db: database.session }, CI_GATE_MAIN_POLICY, 'worker', fixtureDigest('e'), PRODUCTION),
      ).toEqual({
        ok: false,
        reason: 'release_record_unknown',
      });
      expect(await readCiGateRecordFor({ db: database.session }, 'worker', REHEARSED_ONLY)).toBeNull();
      expect(await bindReleaseAttestation({ db: database.session }, CI_GATE_MAIN_POLICY, 'worker', REHEARSED_ONLY, PRODUCTION)).toEqual({
        ok: false,
        reason: 'release_record_unknown',
      });
      expect(await bindReleaseAttestation({ db: database.session }, CI_GATE_MAIN_POLICY, 'worker', 'unknown', PRODUCTION)).toEqual({
        ok: false,
        reason: 'release_record_identity_unknown',
      });
    });

    it('under a named reference, binds only that record: another ci-gate record for this worker admits nothing', async () => {
      // The attestation names the rehearsal record, whose worker is not the one running;
      // the ci-gate record that does name the running worker is not what was attested.
      expect(
        await bindReleaseAttestation({ db: database.session }, 'fss-rh-fixture-policy-only', 'worker', RUNNING, REHEARSAL_STACK),
      ).toEqual({ ok: false, reason: 'release_record_digest_mismatch' });
      expect(
        await bindReleaseAttestation({ db: database.session }, 'ci-gate-41000000299-cccccccccccc', 'worker', RUNNING, PRODUCTION),
      ).toEqual({ ok: false, reason: 'release_record_unknown' });
      expect(await bindReleaseAttestation({ db: database.session }, reference, 'worker', RUNNING, PRODUCTION)).toMatchObject({
        ok: true,
        admittedBy: 'reference',
      });
    });
  });
});

/**
 * An attestation that names one record binds only the CI gate's records in production
 * (26 September 2026). A rehearsal stack keeps binding a rehearsal's record by its
 * reference. Every case names a record that passed and names the running worker, so the
 * only fact that differs is who wrote it and where the question is asked.
 */
describe('a named reference, in production and in a rehearsal stack', () => {
  let database: TestDatabase;
  const REHEARSAL_REFERENCE = 'fss-rh-fixture-2026-09-24T10:00:00Z';
  let ciGateReference = '';
  const bind = async (
    reference: string,
    side: 'api' | 'worker',
    digest: string,
    deployment: { readonly production: boolean },
  ) => await bindReleaseAttestation({ db: database.session }, reference, side, digest, deployment);

  beforeAll(async () => {
    database = await createTestDatabase();
    // A passing record a `full` rehearsal stored before W3-S8, naming the running worker.
    await storeFixtureRecord(database.session, REHEARSAL_REFERENCE);
    // A passing record the CI gate wrote for the same images.
    const record = fixtureCiGateRecord('41000000301');
    expect(await putReleaseRecord({ db: database.session }, record)).toMatchObject({ ok: true });
    ciGateReference = record.releaseGateReference;
  });

  afterAll(async () => {
    await database.drop();
  });

  it('refuses a passing rehearsal record in production as a record nobody stored, on both sides', async () => {
    for (const [side, digest] of [['worker', FIXTURE_WORKER_DIGEST], ['api', FIXTURE_API_DIGEST]] as const) {
      expect(await bind(REHEARSAL_REFERENCE, side, digest, PRODUCTION), side).toEqual({
        ok: false,
        reason: 'release_record_unknown',
      });
    }
    // The same answer as a reference with no row at all.
    expect(await bind('fss-rh-fixture-never-stored', 'worker', FIXTURE_WORKER_DIGEST, PRODUCTION)).toEqual({
      ok: false,
      reason: 'release_record_unknown',
    });
  });

  it('admits the same rehearsal record in a rehearsal stack, by its reference', async () => {
    expect(await bind(REHEARSAL_REFERENCE, 'worker', FIXTURE_WORKER_DIGEST, REHEARSAL_STACK)).toMatchObject({
      ok: true,
      admittedBy: 'reference',
      record: { reference: REHEARSAL_REFERENCE },
    });
  });

  it('admits a passing ci-gate record by its reference, in production and in a rehearsal stack', async () => {
    for (const deployment of [PRODUCTION, REHEARSAL_STACK]) {
      expect(await bind(ciGateReference, 'worker', FIXTURE_WORKER_DIGEST, deployment), String(deployment.production)).toMatchObject({
        ok: true,
        admittedBy: 'reference',
        record: { reference: ciGateReference },
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
