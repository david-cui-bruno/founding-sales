import { describe, expect, it } from 'vitest';
import {
  RELEASE_RECORD_BINDING_REFUSAL_CODES,
  RELEASE_RECORD_SCHEMA_ID,
  isImageDigest,
  releaseRecordSchema,
} from '../src/index.ts';

/**
 * The release record's wire shape (lane g71).
 *
 * The record the rehearsal script writes is parsed by the release suite
 * (`test/release/scenario42.check.ts`); these cases are the contract's own edges. All
 * data is fictional: the digests are repeated letters and the prefix is a rehearsal
 * name nobody ran.
 */

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: RELEASE_RECORD_SCHEMA_ID,
  releaseGateReference: 'fss-rh-example-2026-09-25T07:20:44Z',
  rehearsalPrefix: 'fss-rh-example',
  recordedAt: '2026-09-25T07:20:44Z',
  suite: 'pass',
  artifacts: { api: digest('a'), worker: digest('b'), desktopCommitStamp: 'c'.repeat(40) },
  carryDrill: 'skipped_no_watermark',
  rehearsalScenarios: { '11': 'prefix=fss-rh-example result=pass', '39': 'production_untouched=true' },
  enablesSending: false,
  ...overrides,
});

describe('the release record contract', () => {
  it('accepts the shape the rehearsal script writes', () => {
    const parsed = releaseRecordSchema.safeParse(record());
    expect(parsed.success).toBe(true);
  });

  it('refuses a field it does not know, rather than storing a subset of the claim', () => {
    expect(releaseRecordSchema.safeParse(record({ approvedBy: 'someone' })).success).toBe(false);
  });

  it('refuses a missing field', () => {
    const { suite: _suite, ...withoutSuite } = record();
    expect(releaseRecordSchema.safeParse(withoutSuite).success).toBe(false);
  });

  it('refuses a tag, an upper-case digest and one image under both names', () => {
    const artifacts = (api: string, worker: string) => ({ api, worker, desktopCommitStamp: 'stamp' });
    expect(releaseRecordSchema.safeParse(record({ artifacts: artifacts('latest', digest('b')) })).success).toBe(false);
    expect(
      releaseRecordSchema.safeParse(record({ artifacts: artifacts(`sha256:${'A'.repeat(64)}`, digest('b')) })).success,
    ).toBe(false);
    expect(releaseRecordSchema.safeParse(record({ artifacts: artifacts(digest('a'), digest('a')) })).success).toBe(false);
  });

  it('stores a suite that is not a pass, so the enable rule is the one that refuses it', () => {
    // The script never writes this; the contract still has to be able to carry it, or
    // `release_record_not_passing` could never be reached and its test would be vacuous.
    expect(releaseRecordSchema.safeParse(record({ suite: 'fail' })).success).toBe(true);
    expect(releaseRecordSchema.safeParse(record({ suite: 'PASS!' })).success).toBe(false);
  });

  it('refuses another schema id and a recordedAt that is not an instant', () => {
    expect(releaseRecordSchema.safeParse(record({ schema: 'fss.release-record.v2' })).success).toBe(false);
    expect(releaseRecordSchema.safeParse(record({ recordedAt: '25 September' })).success).toBe(false);
    expect(releaseRecordSchema.safeParse(record({ recordedAt: '2026-13-45T99:99:99Z' })).success).toBe(false);
  });

  it('knows a digest when it sees one, and nothing else', () => {
    expect(isImageDigest(digest('f'))).toBe(true);
    for (const value of ['unknown', '', 'sha256:abc', `${digest('f')}\n`, null, undefined, 42]) {
      expect(isImageDigest(value), String(value)).toBe(false);
    }
  });

  it('has four binding refusals and no duplicates', () => {
    expect(new Set(RELEASE_RECORD_BINDING_REFUSAL_CODES).size).toBe(4);
  });
});
