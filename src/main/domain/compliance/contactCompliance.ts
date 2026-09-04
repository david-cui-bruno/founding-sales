import type { ContactComplianceEvidence } from './contactComplianceTypes';

const DAY_MS = 24 * 60 * 60 * 1000;

export function phoneAreaCode(normalizedPhone: string): string | null {
  const match = /^\+1(\d{3})\d{7}$/.exec(normalizedPhone);
  return match?.[1] ?? null;
}

export function compatibilityFlags(evidence: ContactComplianceEvidence): {
  dncListed: boolean;
  tcpaFlag: boolean;
} {
  return {
    dncListed: evidence.federalStatus === 'listed',
    tcpaFlag: evidence.tcpaFlag === true,
  };
}

export function isFederalEvidenceRefreshDue(input: {
  evidence: ContactComplianceEvidence;
  now: string;
}): boolean {
  if (input.evidence.scrubbedAt === null) return true;
  return new Date(input.now).getTime() >= new Date(input.evidence.scrubbedAt).getTime() + 28 * DAY_MS;
}

export function evaluateFederalEvidence(input: {
  normalizedPhone: string;
  evidence: ContactComplianceEvidence;
  now: string;
}):
  | { kind: 'usable_clear' }
  | { kind: 'blocked'; reasonCode:
      | 'federal_status_unknown'
      | 'federal_dnc_listed'
      | 'federal_evidence_stale'
      | 'federal_area_code_mismatch'
      | 'tcpa_status_unknown'
      | 'tcpa_blocked' } {
  const { evidence } = input;
  if (evidence.federalStatus === 'listed') {
    return { kind: 'blocked', reasonCode: 'federal_dnc_listed' };
  }
  if (evidence.federalStatus === 'unknown') {
    return { kind: 'blocked', reasonCode: 'federal_status_unknown' };
  }
  if (evidence.tcpaFlag === true) {
    return { kind: 'blocked', reasonCode: 'tcpa_blocked' };
  }
  if (evidence.tcpaFlag === null) {
    return { kind: 'blocked', reasonCode: 'tcpa_status_unknown' };
  }
  if (evidence.expiresAt === null || new Date(input.now).getTime() >= new Date(evidence.expiresAt).getTime()) {
    return { kind: 'blocked', reasonCode: 'federal_evidence_stale' };
  }
  if (evidence.coveredAreaCode === null || phoneAreaCode(input.normalizedPhone) !== evidence.coveredAreaCode) {
    return { kind: 'blocked', reasonCode: 'federal_area_code_mismatch' };
  }
  return { kind: 'usable_clear' };
}
