import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  finalizeIdentityMigrationReview,
  serializeIdentityMigrationManifest,
  type IdentityMigrationManifest,
} from '../../../src/main/identityMigration/identityMigrationManifest';

const TIME = '2026-09-06T12:00:00.000Z';
const audit: IdentityMigrationManifest = {
  format: 'callie-identity-migration-audit', version: 1,
  beforeDatabaseSha256: 'a'.repeat(64), currentDatabaseSha256: 'b'.repeat(64), generatedAt: TIME,
  candidates: ['candidate-b', 'candidate-a'].map(candidateId => ({
    candidateId, normalizedDisplayName: 'EXAMPLE LLC', currentPersonId: 'person-a',
    priorPeople: ['prior-b', 'prior-a'].map(priorPersonId => ({
      priorPersonId, displayName: 'Example LLC', postalCodes: [] as string[], propertyAddresses: [] as string[],
      cloudEntityIds: [priorPersonId], sourceEventIds: [] as string[],
    })),
    conflictReasons: ['DIFFERENT_CLOUD_ENTITY_IDS'], contactOwnership: 'unknown',
  })),
};
const decisions = [
  { candidateId: 'candidate-b', decision: 'rejected' },
  { candidateId: 'candidate-a', decision: 'approved' },
];
const bytes = Buffer.from(JSON.stringify(audit, null, 2) + '\n');
const finalize = (rows: unknown = decisions, reviewedAt = TIME, source = bytes) =>
  finalizeIdentityMigrationReview({ auditManifestBytes: source, decisions: rows, reviewedAt });

describe('immutable identity review manifests', () => {
  it('requires a complete partition, hashes exact audit bytes and canonically orders output', () => {
    const result = finalize();
    expect(result).toMatchObject({ format: 'callie-identity-migration-review', version: 1,
      auditManifestSha256: createHash('sha256').update(bytes).digest('hex'), reviewedAt: TIME,
      approvedCandidateIds: ['candidate-a'], rejectedCandidateIds: ['candidate-b'] });
    expect(result.candidates.map(c => c.candidateId)).toEqual(['candidate-a', 'candidate-b']);
    expect(result.candidates[0].priorPeople.map(p => p.priorPersonId)).toEqual(['prior-a', 'prior-b']);
    expect(serializeIdentityMigrationManifest(result))
      .toBe(serializeIdentityMigrationManifest(finalize([...decisions].reverse())));
    expect(finalize(decisions, TIME, Buffer.from(JSON.stringify(audit))).auditManifestSha256)
      .not.toBe(result.auditManifestSha256);
    expect(bytes).toEqual(Buffer.from(JSON.stringify(audit, null, 2) + '\n'));
  });

  it.each([
    [], [decisions[0]], [...decisions, decisions[0]],
    [...decisions, { candidateId: 'unknown', decision: 'approved' }],
    [decisions[0], { candidateId: 'candidate-b', decision: 'approved' }],
    [{ candidateId: 'candidate-a', decision: 'maybe' }, decisions[0]],
    [{ candidateId: 'candidate-a', decision: 'approved', extra: true }, decisions[0]],
    { decisions }, null,
  ])('rejects incomplete, overlapping, duplicate, unknown or non-strict decisions %#', rows => {
    expect(() => finalize(rows)).toThrow();
  });

  it.each(['2026-09-06', '2026-09-06T12:00:00Z', '2026-09-06T08:00:00.000-04:00',
    '2026-02-30T12:00:00.000Z', 'invalid'])('rejects noncanonical reviewedAt %s', value => {
    expect(() => finalize(decisions, value)).toThrow();
  });

  it.each([
    { ...audit, format: 'callie-identity-migration-review' },
    { ...audit, version: 2 }, { ...audit, currentDatabaseSha256: 'bad' },
    { ...audit, extra: true }, { ...audit, generatedAt: '2026-09-06' },
    { ...audit, candidates: [audit.candidates[0], audit.candidates[0]] },
    { ...audit, candidates: [{ ...audit.candidates[0], contactOwnership: 'known' }] },
  ])('rejects malformed or ambiguous immutable audits %#', value => {
    expect(() => finalize(decisions, TIME, Buffer.from(JSON.stringify(value)))).toThrow();
  });

  it('accepts the explicit empty partition for an audit with no candidates', () => {
    expect(finalize([], TIME, Buffer.from(JSON.stringify({ ...audit, candidates: [] }))))
      .toMatchObject({ approvedCandidateIds: [], rejectedCandidateIds: [], candidates: [] });
  });

  it('matches an independently constructed golden reviewed-manifest byte hash', () => {
    const source = Buffer.from('{"format":"callie-identity-migration-audit","version":1,"beforeDatabaseSha256":"'
      + 'a'.repeat(64) + '","currentDatabaseSha256":"' + 'b'.repeat(64)
      + '","generatedAt":"2026-09-06T12:00:00.000Z","candidates":[]}');
    const reviewed = finalize([], TIME, source);
    expect(reviewed.auditManifestSha256).toBe('dd8029ab6dbbf39a43fb3482ea57788af26f44652fd030862e478b34884c66f4');
    expect(createHash('sha256').update(serializeIdentityMigrationManifest(reviewed)).digest('hex'))
      .toBe('8c8e6f8d522996f47cc1bfd769d18814a0ee05465548ee1c0ea231473d68dc19');
  });
});
