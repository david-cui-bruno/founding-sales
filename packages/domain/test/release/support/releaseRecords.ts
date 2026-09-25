import { RELEASE_RECORD_SCHEMA_ID, type ReleaseRecord } from '@fss/contracts';
import type { Queryable } from '../../../db/queryable.ts';
import { putReleaseRecord } from '../../../release/records.ts';

/**
 * Fictional release records for the tests that need one (lane g71).
 *
 * The digests are repeated hex letters, so no test ever holds a digest of a real
 * image, and the prefix is a rehearsal nobody ran. `fixtureDigest('a')` is the API
 * image a test "runs", `fixtureDigest('b')` the worker; a mismatch is any other letter.
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

export function fixtureReleaseRecord(reference: string, options: FixtureRecordOptions = {}): ReleaseRecord {
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
    carryDrill: 'skipped_no_watermark',
    rehearsalScenarios: {
      '11': 'prefix=fss-rh-fixture result=pass',
      '39': 'prefix=fss-rh-fixture production_untouched=true',
    },
    enablesSending: false,
  };
}

/** Store one, through the domain function, and fail the test if it refuses. */
export async function storeFixtureRecord(
  db: Queryable,
  reference: string,
  options: FixtureRecordOptions = {},
): Promise<void> {
  const stored = await putReleaseRecord({ db }, fixtureReleaseRecord(reference, options));
  if (!stored.ok) throw new Error(`the fixture release record was refused: ${stored.reason} ${stored.detail}`);
}
