import { describe, expect, it } from 'vitest';
import {
  discoveryCandidatePayloadSchema, discoveryIntakeRowV1Schema,
  discoveryIntakeSaveCommandSchema, discoveryIntakeSaveInputSchema, discoverySourceKey,
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

describe('unverified discovery intake boundary', () => {
  it('retains missing website/locality and nationwide state without legacy coercion', () => {
    const value = input();
    expect(discoveryIntakeSaveInputSchema.parse(value)).toEqual(value);
    expect(candidateInputSchema.safeParse(value.row).success).toBe(false);
  });
  it.each(['http://example.org/', 'example.org', 'https://example.org/?observed=1'])('retains supplied reference %s without fetching or rewriting', website => {
    const value = input();
    expect(discoveryIntakeSaveInputSchema.parse({ ...value, row: { ...value.row, website } }).row.website).toBe(website);
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
    expect(discoveryIntakeSaveInputSchema.safeParse({ ...value, origins: [] }).success).toBe(false);
    expect(discoveryIntakeSaveInputSchema.safeParse({ ...value, origins: [{ ...value.origins[0], source: { ...value.row.source, recordId: 'other' } }] }).success).toBe(false);
  });
  it.each(['supported', 'rejected'])('does not let raw intake assert residential fit %s', residentialFit => {
    const value = input();
    expect(discoveryIntakeSaveInputSchema.safeParse({ ...value, row: { ...value.row, residentialFit } }).success).toBe(false);
  });
  it('refuses claimed association, first-party phone support and arbitrary body/contact metadata', () => {
    const value = input();
    expect(discoveryIntakeSaveInputSchema.safeParse({ ...value, row: { ...value.row, websiteAssociation: 'supported' } }).success).toBe(false);
    expect(discoveryIntakeSaveInputSchema.safeParse({ ...value, row: { ...value.row, officePhoneEvidence: 'office_supported' } }).success).toBe(false);
    for (const sourcesJson of ['[{"body":"private"}]', '[{"email":"private"}]', '{"dataset":"meta"}', 'not-json']) {
      expect(discoveryIntakeSaveInputSchema.safeParse({ ...value, origins: [{ ...value.origins[0], sourceMetadata: { sourcesJson } }] }).success).toBe(false);
    }
  });
  it('bounds UTF-8 provenance bytes, candidate payload, source counts and unknown fields', () => {
    const value = input();
    const sourcesJson = JSON.stringify(Array.from({ length: 8 }, () => ({ dataset: '界'.repeat(1000) })));
    expect(discoveryIntakeSaveInputSchema.safeParse({ ...value, origins: [{ ...value.origins[0], sourceMetadata: { sourcesJson } }] }).success).toBe(false);
    expect(discoveryCandidatePayloadSchema.safeParse({ kind: 'discovery-v1', row: { ...value.row, body: 'unexpected' } }).success).toBe(false);
    expect(discoveryIntakeSaveInputSchema.safeParse({ ...value, origins: Array.from({ length: 17 }, () => value.origins[0]) }).success).toBe(false);
  });
  it('preserves the normal command envelope and explicit revision-bound attachment', () => {
    const value = input();
    const id = '243703e0-726f-453e-a5a8-eae645b43b2d';
    expect(discoveryIntakeSaveCommandSchema.safeParse({ ...value, commandId: id, clientVersion: '1.0.56', attachTo: { candidateId: id, expectedRevision: 1 } }).success).toBe(true);
    expect(discoveryIntakeSaveCommandSchema.safeParse({ ...value, commandId: id, clientVersion: '1.0.56', row: { ...value.row, residentialFit: 'supported' } }).success).toBe(false);
    expect(discoveryIntakeSaveInputSchema.safeParse({ ...value, attachTo: { candidateId: id, expectedRevision: 0 } }).success).toBe(false);
  });
});
