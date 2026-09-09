import type { AccountClaim, AccountEvidenceSnapshot, AccountRoute } from '../contracts/accountContract';

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type AccountRank = Readonly<{
  accountId: string;
  fit: 'supported' | 'uncertain' | 'not_target';
  contactable: boolean;
  reasons: readonly { text: string; evidenceIds: readonly string[] }[];
  unknowns: readonly string[];
  fingerprint: string;
}>;

function textOf(claim: AccountClaim): string {
  return typeof claim.value === 'string' ? claim.value.toLowerCase() : '';
}

function hasAny(value: string, terms: readonly string[]): boolean {
  return terms.some(term => value.includes(term));
}

function evidenceFrom(claims: readonly AccountClaim[], predicate: (claim: AccountClaim) => boolean): string[] {
  const ids: string[] = [];
  for (const claim of claims) {
    if (!predicate(claim)) continue;
    for (const id of claim.evidenceIds) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function businessRoute(routes: readonly AccountRoute[]): AccountRoute | null {
  return routes.find(route => route.purpose === 'business'
    && (route.channel === 'phone' || route.channel === 'email')
    && route.verification !== 'unverified') ?? null;
}

export function rankAccount(snapshot: AccountEvidenceSnapshot, asOf: string): AccountRank {
  if (!UTC_INSTANT.test(asOf)) throw new Error('asOf must be a canonical UTC timestamp.');
  const reasons: { text: string; evidenceIds: string[] }[] = [];
  const supportedScopeEvidence = evidenceFrom(snapshot.claims, claim => claim.kind === 'fact'
    && claim.key === 'residential_scope'
    && hasAny(textOf(claim), ['residential', 'multifamily', 'multi-family', 'rental', 'apartments']));
  if (supportedScopeEvidence.length > 0) {
    reasons.push({
      text: 'Evidence supports residential or multifamily property management fit.',
      evidenceIds: supportedScopeEvidence,
    });
  }

  const regionalEvidence = evidenceFrom(snapshot.claims, claim => claim.kind === 'fact'
    && claim.key === 'operating_footprint'
    && hasAny(textOf(claim), ['regional', 'local', 'nearby', 'serving', 'county', 'market']));
  if (regionalEvidence.length > 0) {
    reasons.push({ text: 'Evidence supports a regional operating footprint.', evidenceIds: regionalEvidence });
  }

  const operatingEvidence = evidenceFrom(snapshot.claims, claim => claim.kind === 'fact'
    && (claim.key === 'maintenance_workflow' || claim.key === 'technology' || claim.key === 'role'));
  if (operatingEvidence.length > 0) {
    reasons.push({ text: 'Evidence supports property management operating relevance.', evidenceIds: operatingEvidence });
  }

  const route = businessRoute(snapshot.routes);
  if (route !== null) {
    reasons.push({ text: 'Published business route is available for a company-level call.', evidenceIds: [...route.evidenceIds] });
  }

  const unknowns = [...snapshot.unknowns];
  if (route === null && !unknowns.includes('business_route')) unknowns.push('business_route');
  const fit = supportedScopeEvidence.length > 0 && regionalEvidence.length > 0 ? 'supported'
    : snapshot.claims.some(claim => claim.kind === 'fact' && claim.key === 'residential_scope'
      && hasAny(textOf(claim), ['commercial only', 'commercial-only'])) ? 'not_target' : 'uncertain';

  return Object.freeze({
    accountId: snapshot.account.id,
    fit,
    contactable: route !== null,
    reasons,
    unknowns,
    fingerprint: snapshot.fingerprint,
  });
}
