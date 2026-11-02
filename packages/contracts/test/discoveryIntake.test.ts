import { describe, expect, it } from 'vitest';
import {
  discoveryCandidatePayloadSchema, discoveryIntakeRowV1Schema,
  discoveryOriginSchema, discoverySourceKey,
} from '../src/discoveryIntake.ts';
import { candidateInputSchema } from '../src/sourcing.ts';

function input() {
  const source = { provider: 'overture_places' as const, recordId: 'record-1', release: '2026-09-23.1',
    retrievedAt: null, sourceUrl: 'https://example.org/places.parquet' };
  return {
    row: { source, observations: [source], firmName: 'Example Property Management', website: null,
      locality: null, region: 'CA', sourceConfidence: 0.9, residentialFit: 'unknown' as const,
      websiteAssociation: 'unknown' as const, officePhoneEvidence: 'observed_source' as const, probableGroupKey: null },
    origins: [{ source, sourceMetadata: { sourcesJson: '[{"dataset":"meta","record_id":"123","license":"CDLA-Permissive-2.0","between":null}]' },
      licenses: ['CDLA-Permissive-2.0'], notices: [{ label: 'License', url: 'https://example.org/license', sha256: 'a'.repeat(64) }] }],
  };
}

describe('stored discovery-v1 row and origin boundary', () => {
  it('retains missing website/locality and nationwide state without legacy coercion', () => {
    const value = input();
    expect(discoveryIntakeRowV1Schema.parse(value.row)).toEqual(value.row);
    expect(discoveryOriginSchema.parse(value.origins[0])).toEqual(value.origins[0]);
    expect(candidateInputSchema.safeParse(value.row).success).toBe(false);
  });
  it.each(['http://example.org/', 'example.org', 'https://example.org/?observed=1'])('retains supplied reference %s without fetching or rewriting', website => {
    const value = input();
    expect(discoveryIntakeRowV1Schema.parse({ ...value.row, website }).website).toBe(website);
  });
  it('uses exact source identity, not a probable shared host', () => {
    const value = input();
    expect(discoverySourceKey(value.row.source)).not.toBe(discoverySourceKey({ ...value.row.source, recordId: 'branch-2' }));
    expect(discoverySourceKey(value.row.source)).toBe(discoverySourceKey({ ...value.row.source, retrievedAt: '2026-10-21T03:00:00Z' }));
  });
  it('refuses source metadata drift and duplicate observations', () => {
    const value = input();
    expect(discoveryIntakeRowV1Schema.safeParse({ ...value.row, source: { ...value.row.source, retrievedAt: '2026-10-21T03:00:00Z' } }).success).toBe(false);
    expect(discoveryIntakeRowV1Schema.safeParse({ ...value.row, observations: [value.row.source, value.row.source] }).success).toBe(false);
    expect(discoveryOriginSchema.safeParse({ ...value.origins[0], licenses: [] }).success).toBe(false);
    expect(discoveryOriginSchema.safeParse({ ...value.origins[0], notices: [] }).success).toBe(false);
  });
  it('refuses arbitrary body/contact metadata', () => {
    const value = input();
    for (const sourcesJson of ['[{"body":"private"}]', '[{"email":"private"}]', '{"dataset":"meta"}', 'not-json']) {
      expect(discoveryOriginSchema.safeParse({ ...value.origins[0], sourceMetadata: { sourcesJson } }).success).toBe(false);
    }
  });
  it('bounds UTF-8 provenance bytes, origin counts and unknown fields', () => {
    const value = input();
    const sourcesJson = JSON.stringify(Array.from({ length: 8 }, () => ({ dataset: '界'.repeat(1000) })));
    expect(discoveryOriginSchema.safeParse({ ...value.origins[0], sourceMetadata: { sourcesJson } }).success).toBe(false);
    expect(discoveryCandidatePayloadSchema.safeParse({ kind: 'discovery-v1', row: { ...value.row, body: 'unexpected' } }).success).toBe(false);
    expect(discoveryOriginSchema.safeParse({ ...value.origins[0], licenses: Array.from({ length: 17 }, () => 'x') }).success).toBe(false);
  });
});
