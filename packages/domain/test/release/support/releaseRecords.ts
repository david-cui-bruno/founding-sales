import {
  RELEASE_RECORD_SCHEMA_ID,
  ciGateReleaseReference,
  type CiGateReleaseRecord,
} from '@fss/contracts';
import type { Queryable } from '../../../db/queryable.ts';
import { putReleaseRecord } from '../../../release/records.ts';

/**
 * Fictional release records for the tests that need one (lane g71).
 *
 * The digests are repeated hex letters, so no test ever holds a digest of a real
 * image. `fixtureDigest('a')` is the API image a test "runs", `fixtureDigest('b')` the
 * worker; a mismatch is any other letter.
 */

export const fixtureDigest = (letter: string): string => `sha256:${letter.repeat(64)}`;

export const FIXTURE_API_DIGEST = fixtureDigest('a');
export const FIXTURE_WORKER_DIGEST = fixtureDigest('b');

export interface FixtureRecordOptions {
  readonly suite?: string;
  readonly api?: string;
  readonly worker?: string;
  readonly desktopCommitStamp?: string;
}

/**
 * A record a green `full` rehearsal stored before lane W3-S8 deleted that mode: no
 * `source`, the drill fields, any reference. A put refuses one now; production still holds
 * rows like it, and the rules read them by their columns, so `storeFixtureRecord` inserts
 * one the way it was stored then.
 */
export function fixtureReleaseRecord(reference: string, options: FixtureRecordOptions = {}): Readonly<Record<string, unknown>> {
  return {
    schema: RELEASE_RECORD_SCHEMA_ID,
    releaseGateReference: reference,
    rehearsalPrefix: 'fss-rh-fixture',
    recordedAt: '2026-09-25T07:20:44Z',
    suite: options.suite ?? 'pass',
    artifacts: {
      api: options.api ?? FIXTURE_API_DIGEST,
      worker: options.worker ?? FIXTURE_WORKER_DIGEST,
      desktopCommitStamp: options.desktopCommitStamp ?? 'd'.repeat(40),
    },
    rehearsalScenarios: {
      '11': 'prefix=fss-rh-fixture result=pass',
      '39': 'prefix=fss-rh-fixture production_untouched=true',
    },
    enablesSending: false,
  };
}

/** Store a rehearsal-era record under `reference`, as a row put before lane W3-S8. */
export async function storeFixtureRecord(
  db: Queryable,
  reference: string,
  options: FixtureRecordOptions = {},
): Promise<void> {
  const record = fixtureReleaseRecord(reference, options);
  await db.query(
    `INSERT INTO release_records
       (reference, recorded_at, suite, api_digest, worker_digest, desktop_commit_stamp, enables_sending, record)
     VALUES ($1, TIMESTAMPTZ '2026-09-25T07:20:44Z', $2, $3, $4, $5, false, $6::jsonb)`,
    [
      reference,
      options.suite ?? 'pass',
      options.api ?? FIXTURE_API_DIGEST,
      options.worker ?? FIXTURE_WORKER_DIGEST,
      options.desktopCommitStamp ?? 'd'.repeat(40),
      JSON.stringify(record),
    ],
  );
}

/**
 * A record from the CI gate (lane g96): the shape `release-record-from-ci.sh` writes,
 * with no drill evidence. The run id is the only thing a test varies, so each case gets
 * its own reference (`ci-gate-<run>-<commit>`); the commit is repeated letters.
 */
export const FIXTURE_CI_COMMIT = 'c'.repeat(40);

export function fixtureCiGateRecord(gateRunId: string, options: FixtureRecordOptions = {}): CiGateReleaseRecord {
  return {
    schema: RELEASE_RECORD_SCHEMA_ID,
    source: 'ci-gate',
    releaseGateReference: ciGateReleaseReference(gateRunId, FIXTURE_CI_COMMIT),
    recordedAt: '2026-09-25T21:40:12Z',
    suite: options.suite ?? 'pass',
    commit: FIXTURE_CI_COMMIT,
    gateRunId,
    gateRunUrl: `https://github.com/example-owner/example-repo/actions/runs/${gateRunId}`,
    imagesRunId: '1',
    artifacts: {
      api: options.api ?? FIXTURE_API_DIGEST,
      worker: options.worker ?? FIXTURE_WORKER_DIGEST,
      desktopCommitStamp: FIXTURE_CI_COMMIT,
    },
    enablesSending: true,
  };
}

/** Store a CI-gate record and answer its reference, which is what the attestation names. */
export async function storeFixtureCiGateRecord(
  db: Queryable,
  gateRunId: string,
  options: FixtureRecordOptions = {},
): Promise<string> {
  const record = fixtureCiGateRecord(gateRunId, options);
  const stored = await putReleaseRecord({ db }, record);
  if (!stored.ok) throw new Error(`the fixture ci-gate record was refused: ${stored.reason} ${stored.detail}`);
  return record.releaseGateReference;
}
