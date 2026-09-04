import { describe, expect, it } from 'vitest';

import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import {
  evaluateCallRecordingAuthorization,
  evaluateOutboundAuthorization,
  type CallRecordingConsentEvidence,
} from '../../src/main/domain/compliance/outboundAuthorization';
import type { ContactComplianceEvidence } from '../../src/main/domain/compliance/contactComplianceTypes';

const CLEAR: ContactComplianceEvidence = {
  federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401',
  source: 'ftc_download', scrubbedAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-10-01T00:00:00.000Z',
};
const jurisdiction: NonNullable<Parameters<typeof evaluateOutboundAuthorization>[0]['jurisdiction']> = {
  regionCode: 'RI', timezone: 'America/New_York', reviewAt: null,
};
const clearance = {
  decision: 'allowed' as const, registrationConfirmed: true,
  stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true,
  effectiveAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z',
};
function decide(overrides: Partial<Parameters<typeof evaluateOutboundAuthorization>[0]> = {}) {
  return evaluateOutboundAuthorization({
    channel: 'call', now: '2026-09-04T14:00:00.000Z', personOrHandleOptedOut: false,
    contact: { kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid', evidence: CLEAR },
    jurisdiction, clearance, windows: FOUNDER_CHANNEL_POLICIES_V1, ...overrides,
  });
}

describe('evaluateOutboundAuthorization', () => {
  it('does not infer recipient jurisdiction from the phone area code', () => {
    expect(decide({ jurisdiction: null })).toEqual({ kind: 'refused', reasonCode: 'jurisdiction_unknown' });
  });

  it('blocks MA calls under the seeded policy', () => {
    expect(decide({ jurisdiction: { ...jurisdiction, regionCode: 'MA' }, clearance: { ...clearance, decision: 'blocked' } }))
      .toEqual({ kind: 'refused', reasonCode: 'jurisdiction_blocked' });
  });

  it('blocks RI and CT calls while obligations are unknown', () => {
    const unknown: NonNullable<Parameters<typeof evaluateOutboundAuthorization>[0]['clearance']> = {
      ...clearance, decision: 'unknown', registrationConfirmed: null,
      stateDncSubscriptionConfirmed: null, consentRuleConfirmed: null };
    expect(decide({ clearance: unknown })).toEqual({ kind: 'refused', reasonCode: 'jurisdiction_blocked' });
    expect(decide({ jurisdiction: { ...jurisdiction, regionCode: 'CT' }, clearance: unknown }))
      .toEqual({ kind: 'refused', reasonCode: 'jurisdiction_blocked' });
  });

  it('blocks missing and expired state clearance', () => {
    expect(decide({ clearance: null })).toEqual({ kind: 'refused', reasonCode: 'jurisdiction_unknown' });
    expect(decide({ clearance: { ...clearance, expiresAt: '2026-09-04T13:59:59.999Z' } }))
      .toEqual({ kind: 'refused', reasonCode: 'jurisdiction_unknown' });
  });

  it('blocks missing registration, state DNC subscription, and consent decisions', () => {
    expect(decide({ clearance: { ...clearance, registrationConfirmed: null } }))
      .toEqual({ kind: 'refused', reasonCode: 'state_registration_missing' });
    expect(decide({ clearance: { ...clearance, stateDncSubscriptionConfirmed: null } }))
      .toEqual({ kind: 'refused', reasonCode: 'state_dnc_subscription_missing' });
    expect(decide({ clearance: { ...clearance, consentRuleConfirmed: null } }))
      .toEqual({ kind: 'refused', reasonCode: 'state_consent_rule_unknown' });
  });

  it('allows a fully cleared state inside the recipient-local call window', () => {
    expect(decide()).toEqual({ kind: 'allowed' });
  });

  it('refuses vendor-sourced clear federal evidence', () => {
    expect(decide({ contact: {
      kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid',
      evidence: { ...CLEAR, source: 'enrichment_vendor' },
    } })).toEqual({ kind: 'refused', reasonCode: 'federal_status_unknown' });
  });

  it('refuses future and noncanonical federal timestamps', () => {
    expect(decide({ contact: {
      kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid',
      evidence: { ...CLEAR, scrubbedAt: '2026-09-04T15:00:00.000Z' },
    } })).toEqual({ kind: 'refused', reasonCode: 'federal_evidence_stale' });
    expect(decide({ contact: {
      kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid',
      evidence: { ...CLEAR, scrubbedAt: '2026-09-01T00:00:00Z' },
    } })).toEqual({ kind: 'refused', reasonCode: 'federal_evidence_stale' });
  });

  it('refuses federal evidence with a lifetime over 31 days', () => {
    expect(decide({ contact: {
      kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid',
      evidence: { ...CLEAR, scrubbedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2026-10-01T00:00:00.000Z' },
    } })).toEqual({ kind: 'refused', reasonCode: 'federal_evidence_stale' });
  });

  it('refuses one millisecond before opening and at the exclusive closing boundary', () => {
    expect(decide({ now: '2026-09-04T12:59:59.999Z' })).toEqual({ kind: 'refused', reasonCode: 'outside_recipient_window' });
    expect(decide({ now: '2026-09-05T00:00:00.000Z' })).toEqual({ kind: 'refused', reasonCode: 'outside_recipient_window' });
  });

  it('handles DST transitions in the recipient timezone without using host-local time', () => {
    const yearlong = { ...clearance, effectiveAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z' };
    const springEvidence = { ...CLEAR, scrubbedAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-04-01T00:00:00.000Z' };
    const fallEvidence = { ...CLEAR, scrubbedAt: '2026-10-15T00:00:00.000Z',
      expiresAt: '2026-11-15T00:00:00.000Z' };
    expect(decide({ now: '2026-03-08T17:00:00.000Z', clearance: yearlong,
      contact: { kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid', evidence: springEvidence } }))
      .toEqual({ kind: 'allowed' });
    expect(decide({ now: '2026-11-01T18:00:00.000Z', clearance: yearlong,
      contact: { kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid', evidence: fallEvidence } }))
      .toEqual({ kind: 'allowed' });
  });
});

describe('evaluateCallRecordingAuthorization', () => {
  const granted: CallRecordingConsentEvidence = {
    decision: 'granted', source: 'founder_confirmation', evidenceRef: 'consent-1',
    observedAt: '2026-09-04T13:00:00.000Z', expiresAt: '2026-09-05T00:00:00.000Z',
  };
  it('does not treat an allowed call decision as recording consent', () => {
    expect(evaluateCallRecordingAuthorization({ callDecision: { kind: 'allowed' }, consent: null, now: '2026-09-04T14:00:00.000Z' }))
      .toEqual({ kind: 'refused', reasonCode: 'recording_consent_unknown' });
  });
  it('refuses recording when call eligibility is allowed but recording consent is unknown', () => {
    expect(evaluateCallRecordingAuthorization({ callDecision: { kind: 'allowed' }, consent: { ...granted, decision: 'unknown' }, now: '2026-09-04T14:00:00.000Z' }))
      .toEqual({ kind: 'refused', reasonCode: 'recording_consent_unknown' });
  });
  it('allows recording only with a separately current granted consent decision', () => {
    expect(evaluateCallRecordingAuthorization({ callDecision: { kind: 'allowed' }, consent: granted, now: '2026-09-04T14:00:00.000Z' }))
      .toEqual({ kind: 'allowed' });
  });
  it('refuses recording with blank consent provenance', () => {
    expect(evaluateCallRecordingAuthorization({ callDecision: { kind: 'allowed' },
      consent: { ...granted, source: '  ' }, now: '2026-09-04T14:00:00.000Z' }))
      .toEqual({ kind: 'refused', reasonCode: 'recording_consent_stale' });
    expect(evaluateCallRecordingAuthorization({ callDecision: { kind: 'allowed' },
      consent: { ...granted, evidenceRef: '\t' }, now: '2026-09-04T14:00:00.000Z' }))
      .toEqual({ kind: 'refused', reasonCode: 'recording_consent_stale' });
  });
  it('refuses recording with noncanonical timestamps', () => {
    expect(evaluateCallRecordingAuthorization({ callDecision: { kind: 'allowed' },
      consent: granted, now: '2026-09-04T14:00:00Z' }))
      .toEqual({ kind: 'refused', reasonCode: 'recording_consent_stale' });
    expect(evaluateCallRecordingAuthorization({ callDecision: { kind: 'allowed' },
      consent: { ...granted, observedAt: '2026-09-04T13:00:00Z' }, now: '2026-09-04T14:00:00.000Z' }))
      .toEqual({ kind: 'refused', reasonCode: 'recording_consent_stale' });
    expect(evaluateCallRecordingAuthorization({ callDecision: { kind: 'allowed' },
      consent: { ...granted, expiresAt: '2026-09-05T00:00:00Z' }, now: '2026-09-04T14:00:00.000Z' }))
      .toEqual({ kind: 'refused', reasonCode: 'recording_consent_stale' });
  });
});
