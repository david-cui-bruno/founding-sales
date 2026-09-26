import { describe, expect, it } from 'vitest';
import {
  CI_GATE_MAIN_POLICY,
  RELEASE_RECORD_BINDING_REFUSAL_CODES,
  RELEASE_RECORD_SCHEMA_ID,
  ciGateReleaseReference,
  releaseAttestationOf,
  sendingEnabledSettingSchema,
  isImageDigest,
  releaseRecordSchema,
  releaseRecordSource,
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

/**
 * Lane g96: the record from the CI gate (`infra/scripts/release-record-from-ci.sh`).
 *
 * The drill fields are the rehearsal's alone. A `ci-gate` record is accepted without
 * them and refused with them; a rehearsal record is still refused without any one of
 * them. Every other field keeps its rule, and the ones a `ci-gate` record adds are tied
 * to each other: the reference, the run URL and the desktop stamp are derived from the
 * run id and the commit.
 */
describe('the ci-gate release record', () => {
  const COMMIT = 'e'.repeat(40);
  const RUN = '41000000001';
  const ciRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schema: RELEASE_RECORD_SCHEMA_ID,
    source: 'ci-gate',
    releaseGateReference: ciGateReleaseReference(RUN, COMMIT),
    recordedAt: '2026-09-25T21:40:12Z',
    suite: 'pass',
    commit: COMMIT,
    gateRunId: RUN,
    gateRunUrl: `https://github.com/example-owner/example-repo/actions/runs/${RUN}`,
    imagesRunId: '41000000002',
    artifacts: { api: digest('a'), worker: digest('b'), desktopCommitStamp: COMMIT },
    enablesSending: true,
    ...overrides,
  });

  it('accepts the shape the CI script writes, with no drill evidence, and says it is ci-gate', () => {
    const parsed = releaseRecordSchema.safeParse(ciRecord());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) expect(releaseRecordSource(parsed.data)).toBe('ci-gate');
    expect(ciGateReleaseReference(RUN, COMMIT)).toBe(`ci-gate-${RUN}-${'e'.repeat(12)}`);
  });

  it('refuses a ci-gate record that claims a drill a CI run did not do', () => {
    for (const claim of [
      { rehearsalScenarios: { '11': 'result=pass' } },
      { rehearsalPrefix: 'fss-rh-example' },
    ]) {
      expect(releaseRecordSchema.safeParse(ciRecord(claim)).success, JSON.stringify(claim)).toBe(false);
    }
  });

  it('still requires every drill field of a rehearsal record, with or without source spelled out', () => {
    for (const field of ['rehearsalScenarios', 'rehearsalPrefix']) {
      const { [field]: _dropped, ...without } = record();
      expect(releaseRecordSchema.safeParse(without).success, field).toBe(false);
      expect(releaseRecordSchema.safeParse({ ...without, source: 'rehearsal' }).success, field).toBe(false);
    }
    const explicit = releaseRecordSchema.safeParse(record({ source: 'rehearsal' }));
    expect(explicit.success).toBe(true);
    if (explicit.success) expect(releaseRecordSource(explicit.data)).toBe('rehearsal');
    const implicit = releaseRecordSchema.safeParse(record());
    if (implicit.success) expect(releaseRecordSource(implicit.data)).toBe('rehearsal');
    expect(releaseRecordSchema.safeParse(record({ source: 'laptop' })).success).toBe(false);
  });

  it('refuses a missing run, commit or URL, and a field it does not know', () => {
    for (const field of ['commit', 'gateRunId', 'gateRunUrl', 'imagesRunId', 'suite', 'artifacts']) {
      const { [field]: _dropped, ...without } = ciRecord();
      expect(releaseRecordSchema.safeParse(without).success, field).toBe(false);
    }
    expect(releaseRecordSchema.safeParse(ciRecord({ approvedBy: 'someone' })).success).toBe(false);
  });

  it('keeps the digest rules and the suite rule of the rehearsal record', () => {
    const artifacts = (api: string, worker: string) => ({ api, worker, desktopCommitStamp: COMMIT });
    expect(releaseRecordSchema.safeParse(ciRecord({ artifacts: artifacts('latest', digest('b')) })).success).toBe(false);
    expect(releaseRecordSchema.safeParse(ciRecord({ artifacts: artifacts(digest('a'), digest('a')) })).success).toBe(false);
    expect(releaseRecordSchema.safeParse(ciRecord({ suite: 'fail' })).success).toBe(true);
    expect(releaseRecordSchema.safeParse(ciRecord({ suite: 'PASS!' })).success).toBe(false);
  });

  it('ties the reference, the run URL and the desktop stamp to the run and the commit', () => {
    const refusedAt = (overrides: Record<string, unknown>): string[] => {
      const parsed = releaseRecordSchema.safeParse(ciRecord(overrides));
      return parsed.success ? [] : [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))];
    };
    expect(refusedAt({ releaseGateReference: 'fss-rh-example-2026-09-25T07:20:44Z' })).toEqual(['releaseGateReference']);
    expect(refusedAt({ gateRunUrl: 'https://github.com/example-owner/example-repo/actions/runs/41000000009' })).toEqual([
      'gateRunUrl',
    ]);
    expect(refusedAt({ gateRunUrl: `https://example.com/actions/runs/${RUN}` })).toEqual(['gateRunUrl']);
    expect(refusedAt({ imagesRunId: RUN })).toEqual(['imagesRunId']);
    expect(refusedAt({ artifacts: { api: digest('a'), worker: digest('b'), desktopCommitStamp: 'f'.repeat(40) } })).toEqual([
      'artifacts.desktopCommitStamp',
    ]);
    expect(refusedAt({ commit: COMMIT.slice(0, 12) })).toContain('commit');
    expect(refusedAt({ gateRunId: '0' })).toContain('gateRunId');
  });
});

describe('the process attestation, ci-gate:main (lane g100)', () => {
  it('reads the policy by its exact name, and anything else as one reference', () => {
    expect(CI_GATE_MAIN_POLICY).toBe('ci-gate:main');
    expect(releaseAttestationOf('ci-gate:main')).toEqual({ kind: 'policy', policy: 'ci-gate:main' });
    for (const reference of ['ci-gate-41000000001-c0ffeec0ffee', 'fss-rh-example-2026-09-25T07:20:44Z', 'ci-gate:Main', 'ci-gate:main ']) {
      expect(releaseAttestationOf(reference), reference).toEqual({ kind: 'reference', reference });
    }
  });

  it('is an attestation the settings shape already carries, with nothing new in it', () => {
    expect(sendingEnabledSettingSchema.safeParse({ enabled: true, releaseGateReference: CI_GATE_MAIN_POLICY }).success).toBe(true);
  });

  it('is a name no record may carry, so the policy never means one stored row', () => {
    expect(releaseRecordSchema.safeParse(record({ releaseGateReference: CI_GATE_MAIN_POLICY })).success).toBe(false);
    expect(releaseRecordSchema.safeParse(record({ releaseGateReference: 'ci-gate:main-2' })).success).toBe(true);
  });
});
