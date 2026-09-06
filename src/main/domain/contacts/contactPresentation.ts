import type {
  ContactMethod,
  PhoneComplianceStatus,
} from '../../../shared/contracts/leadDetailContract';

const ownershipOrder: Record<ContactMethod['ownershipState'], number> = {
  verified_person: 0,
  vendor_candidate: 1,
  unknown: 2,
  conflicting_identity: 3,
};

/** A positive list hit is distinct from other non-actionable evidence. */
export function isPositivelyBlocked(status: PhoneComplianceStatus): boolean {
  return status === 'federal_dnc_listed' || status === 'tcpa_blocked';
}

/** Presentation only. The DTO value already contains the normalized phone. */
export function comparePhoneCandidates(left: ContactMethod, right: ContactMethod): number {
  const leftStatus = left.compliance?.status ?? 'compliance_unknown';
  const rightStatus = right.compliance?.status ?? 'compliance_unknown';
  const evidenceOrder = Number(isPositivelyBlocked(leftStatus)) - Number(isPositivelyBlocked(rightStatus))
    || Number(rightStatus === 'verified_clear') - Number(leftStatus === 'verified_clear')
    || ownershipOrder[left.ownershipState] - ownershipOrder[right.ownershipState];
  if (evidenceOrder !== 0) return evidenceOrder;
  if (left.vendorRank !== right.vendorRank) {
    if (left.vendorRank === null) return 1;
    if (right.vendorRank === null) return -1;
    return left.vendorRank - right.vendorRank;
  }
  if (left.value !== right.value) return left.value < right.value ? -1 : 1;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

/** Rank one is a candidate preference, never proof of ownership or authorization. */
export function selectPrimaryPhone(
  phones: readonly ContactMethod[],
): { primary: ContactMethod | null; alternatives: ContactMethod[] } {
  const ordered = [...phones].sort(comparePhoneCandidates);
  const nonpositive = ordered.filter((phone) =>
    !isPositivelyBlocked(phone.compliance?.status ?? 'compliance_unknown'));
  const primary = nonpositive.find((phone) => phone.vendorRank === 1) ?? nonpositive[0] ?? null;
  const alternatives = [...ordered];
  if (primary !== null) alternatives.splice(alternatives.indexOf(primary), 1);
  return { primary, alternatives };
}
