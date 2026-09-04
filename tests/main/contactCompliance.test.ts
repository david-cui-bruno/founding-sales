import { describe, expect, it } from 'vitest';

import {
  compatibilityFlags,
  evaluateFederalEvidence,
  isFederalEvidenceRefreshDue,
  phoneAreaCode,
} from '../../src/main/domain/compliance/contactCompliance';
import {
  contactComplianceEvidenceSchema,
  type ContactComplianceEvidence,
} from '../../src/main/domain/compliance/contactComplianceTypes';

const NOW = '2026-09-04T12:00:00.000Z';
const CLEAR: ContactComplianceEvidence = {
  federalStatus: 'verified_clear',
  tcpaFlag: false,
  coveredAreaCode: '401',
  source: 'ftc_download',
  scrubbedAt: '2026-08-20T12:00:00.000Z',
  expiresAt: '2026-09-20T12:00:00.000Z',
};

describe('contact compliance evidence', () => {
  it('defaults a manual phone to explicit unknown evidence', () => {
    expect(contactComplianceEvidenceSchema.parse({})).toEqual({
      federalStatus: 'unknown',
      tcpaFlag: null,
      coveredAreaCode: null,
      source: 'legacy',
      scrubbedAt: null,
      expiresAt: null,
    });
    expect(compatibilityFlags(contactComplianceEvidenceSchema.parse({}))).toEqual({
      dncListed: false,
      tcpaFlag: false,
    });
  });

  it('accepts verified clear only for a fresh matching area code', () => {
    expect(phoneAreaCode('+14015550100')).toBe('401');
    expect(evaluateFederalEvidence({ normalizedPhone: '+14015550100', evidence: CLEAR, now: NOW }))
      .toEqual({ kind: 'usable_clear' });
  });

  it('rejects a verified-clear expiration more than 31 days after the scrub timestamp', () => {
    expect(() => contactComplianceEvidenceSchema.parse({
      ...CLEAR,
      expiresAt: '2026-09-21T12:00:00.001Z',
    })).toThrow(/31 days/i);
  });

  it('marks evidence refresh-due at 28 days without extending its authorization lifetime', () => {
    const evidence = contactComplianceEvidenceSchema.parse({
      ...CLEAR,
      scrubbedAt: '2026-08-07T12:00:00.000Z',
      expiresAt: '2026-09-07T12:00:00.000Z',
    });
    expect(isFederalEvidenceRefreshDue({ evidence, now: NOW })).toBe(true);
    expect(evaluateFederalEvidence({ normalizedPhone: '+14015550100', evidence, now: NOW }))
      .toEqual({ kind: 'usable_clear' });
  });

  it.each([
    ['unknown', { ...CLEAR, federalStatus: 'unknown' }, 'federal_status_unknown'],
    ['listed', { ...CLEAR, federalStatus: 'listed' }, 'federal_dnc_listed'],
    ['stale', { ...CLEAR, expiresAt: '2026-09-04T11:59:59.999Z' }, 'federal_evidence_stale'],
    ['wrong-area', { ...CLEAR, coveredAreaCode: '617' }, 'federal_area_code_mismatch'],
    ['TCPA-positive', { ...CLEAR, tcpaFlag: true }, 'tcpa_blocked'],
    ['TCPA-unknown', { ...CLEAR, tcpaFlag: null }, 'tcpa_status_unknown'],
  ] as const)('blocks %s evidence', (_label, evidence, reasonCode) => {
    expect(evaluateFederalEvidence({
      normalizedPhone: '+14015550100',
      evidence: evidence as ContactComplianceEvidence,
      now: NOW,
    })).toEqual({ kind: 'blocked', reasonCode });
  });

  it.each([
    ['missing scrub time', { ...CLEAR, scrubbedAt: null }, NOW],
    ['future scrub time', { ...CLEAR, scrubbedAt: '2026-09-04T12:00:00.001Z' }, NOW],
    ['malformed scrub time', { ...CLEAR, scrubbedAt: 'not-a-timestamp' }, NOW],
    ['noncanonical scrub time', { ...CLEAR, scrubbedAt: '2026-08-20T08:00:00-04:00' }, NOW],
    ['malformed expiration', { ...CLEAR, expiresAt: 'not-a-timestamp' }, NOW],
    ['noncanonical expiration', { ...CLEAR, expiresAt: '2026-09-20T08:00:00-04:00' }, NOW],
    ['malformed current time', CLEAR, 'not-a-timestamp'],
    ['noncanonical current time', CLEAR, '2026-09-04T08:00:00-04:00'],
    ['expiration before scrub time', {
      ...CLEAR,
      scrubbedAt: '2026-08-20T12:00:00.000Z',
      expiresAt: '2026-08-19T12:00:00.000Z',
    }, '2026-08-10T12:00:00.000Z'],
    ['expiration over 31 days after scrub', {
      ...CLEAR,
      scrubbedAt: '2026-08-01T12:00:00.000Z',
      expiresAt: '2026-09-02T12:00:00.000Z',
    }, '2026-08-15T12:00:00.000Z'],
  ] as const)('fails closed for %s without relying on schema parsing', (_label, evidence, now) => {
    expect(evaluateFederalEvidence({
      normalizedPhone: '+14015550100',
      evidence: evidence as ContactComplianceEvidence,
      now,
    })).toEqual({ kind: 'blocked', reasonCode: 'federal_evidence_stale' });
  });

  it.each(['enrichment_vendor', 'legacy'] as const)(
    'rejects non-authoritative %s verified-clear evidence inside the evaluator',
    (source) => {
      expect(evaluateFederalEvidence({
        normalizedPhone: '+14015550100',
        evidence: { ...CLEAR, source },
        now: NOW,
      })).toEqual({ kind: 'blocked', reasonCode: 'federal_status_unknown' });
    },
  );
});
