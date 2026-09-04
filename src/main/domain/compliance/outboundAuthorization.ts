import type { ChannelPolicySnapshots } from '../cadence/cadenceScheduler';
import { evaluateFederalEvidence } from './contactCompliance';
import type { ContactComplianceEvidence } from './contactComplianceTypes';

export type OutboundChannel = 'call' | 'text';
export type OutboundAuthorizationReasonCode =
  | 'person_or_handle_opted_out'
  | 'channel_contact_kind_mismatch'
  | 'contact_validation_unusable'
  | 'federal_status_unknown'
  | 'federal_dnc_listed'
  | 'federal_evidence_stale'
  | 'federal_area_code_mismatch'
  | 'tcpa_status_unknown'
  | 'tcpa_blocked'
  | 'jurisdiction_unknown'
  | 'jurisdiction_blocked'
  | 'state_registration_missing'
  | 'state_dnc_subscription_missing'
  | 'state_consent_rule_unknown'
  | 'outside_recipient_window';
export type OutboundAuthorizationDecision =
  | Readonly<{ kind: 'allowed' }>
  | Readonly<{ kind: 'refused'; reasonCode: OutboundAuthorizationReasonCode }>;

export type CallRecordingConsentEvidence = Readonly<{
  decision: 'unknown' | 'granted' | 'denied';
  source: string | null;
  evidenceRef: string | null;
  observedAt: string | null;
  expiresAt: string | null;
}>;
export type CallRecordingAuthorizationDecision =
  | Readonly<{ kind: 'allowed' }>
  | Readonly<{ kind: 'refused'; reasonCode:
      | 'recording_call_not_allowed'
      | 'recording_consent_unknown'
      | 'recording_consent_denied'
      | 'recording_consent_stale' }>;

type AuthorizationInput = {
  channel: OutboundChannel;
  now: string;
  personOrHandleOptedOut: boolean;
  contact: {
    kind: 'phone' | 'email';
    normalizedValue: string;
    validationState: 'unverified' | 'valid' | 'invalid';
    evidence: ContactComplianceEvidence;
  };
  jurisdiction: { regionCode: string; timezone: string; reviewAt: string | null } | null;
  clearance: {
    decision: 'unknown' | 'allowed' | 'blocked';
    registrationConfirmed: boolean | null;
    stateDncSubscriptionConfirmed: boolean | null;
    consentRuleConfirmed: boolean | null;
    effectiveAt: string;
    expiresAt: string | null;
  } | null;
  windows: ChannelPolicySnapshots;
};

const refused = (reasonCode: OutboundAuthorizationReasonCode): OutboundAuthorizationDecision => (
  { kind: 'refused', reasonCode }
);

function instant(value: string): number | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date.getTime() : null;
}
function localParts(epoch: number, timezone: string): { weekday: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(epoch));
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value.weekday ?? '');
    if (weekday < 0) return null;
    return { weekday, minute: Number(value.hour) * 60 + Number(value.minute) };
  } catch {
    return null;
  }
}

export function evaluateOutboundAuthorization(input: AuthorizationInput): OutboundAuthorizationDecision {
  const now = instant(input.now);
  if (now === null) return refused('jurisdiction_unknown');
  if (input.personOrHandleOptedOut) return refused('person_or_handle_opted_out');
  if (input.contact.kind !== 'phone') return refused('channel_contact_kind_mismatch');
  if (input.contact.validationState !== 'valid') return refused('contact_validation_unusable');
  const federal = evaluateFederalEvidence({
    normalizedPhone: input.contact.normalizedValue,
    evidence: input.contact.evidence,
    now: input.now,
  });
  if (federal.kind === 'blocked') return refused(federal.reasonCode);
  if (input.jurisdiction === null) return refused('jurisdiction_unknown');
  const reviewAt = input.jurisdiction.reviewAt === null ? null : instant(input.jurisdiction.reviewAt);
  if (input.jurisdiction.reviewAt !== null && (reviewAt === null || reviewAt <= now)) {
    return refused('jurisdiction_unknown');
  }
  const local = localParts(now, input.jurisdiction.timezone);
  if (local === null) return refused('jurisdiction_unknown');
  if (input.clearance === null) return refused('jurisdiction_unknown');
  const effectiveAt = instant(input.clearance.effectiveAt);
  const clearanceExpiry = input.clearance.expiresAt === null ? null : instant(input.clearance.expiresAt);
  if (effectiveAt === null || effectiveAt > now
    || (input.clearance.expiresAt !== null && (clearanceExpiry === null || clearanceExpiry <= now))) {
    return refused('jurisdiction_unknown');
  }
  if (input.clearance.decision !== 'allowed') return refused('jurisdiction_blocked');
  if (input.clearance.registrationConfirmed !== true) return refused('state_registration_missing');
  if (input.clearance.stateDncSubscriptionConfirmed !== true) return refused('state_dnc_subscription_missing');
  if (input.clearance.consentRuleConfirmed !== true) return refused('state_consent_rule_unknown');
  const inside = input.windows[input.channel].windows.some((window) => (
    window.days.includes(local.weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6)
    && local.minute >= window.startMinute
    && local.minute < window.endMinute
  ));
  return inside ? { kind: 'allowed' } : refused('outside_recipient_window');
}

export function evaluateCallRecordingAuthorization(input: {
  callDecision: OutboundAuthorizationDecision;
  consent: CallRecordingConsentEvidence | null;
  now: string;
}): CallRecordingAuthorizationDecision {
  if (input.callDecision.kind !== 'allowed') {
    return { kind: 'refused', reasonCode: 'recording_call_not_allowed' };
  }
  if (input.consent === null || input.consent.decision === 'unknown') {
    return { kind: 'refused', reasonCode: 'recording_consent_unknown' };
  }
  if (input.consent.decision === 'denied') {
    return { kind: 'refused', reasonCode: 'recording_consent_denied' };
  }
  const now = instant(input.now);
  const observedAt = input.consent.observedAt === null ? null : instant(input.consent.observedAt);
  const expiresAt = input.consent.expiresAt === null ? null : instant(input.consent.expiresAt);
  if (now === null || observedAt === null || observedAt > now || expiresAt === null || expiresAt <= now
    || input.consent.source?.trim() === '' || input.consent.source === null
    || input.consent.evidenceRef?.trim() === '' || input.consent.evidenceRef === null) {
    return { kind: 'refused', reasonCode: 'recording_consent_stale' };
  }
  return { kind: 'allowed' };
}
