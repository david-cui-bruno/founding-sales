import { createHash } from 'node:crypto';
import type { Account, AccountClaim, AccountEvidenceSnapshot, AccountRoute } from '../../../shared/contracts/accountContract';

/** Stable fingerprints ignore object insertion order, never array order or content. */
export function accountFingerprint(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical)
    : entry !== null && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : entry;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function projectAccountEvidence(account: Account, claims: AccountClaim[], routes: AccountRoute[]): AccountEvidenceSnapshot {
  const portfolio = claims.flatMap(claim => claim.key === 'portfolio' && claim.kind === 'fact'
    ? [{ ...claim.value, evidenceIds: [...claim.evidenceIds] }] : []);
  const counts = new Map<string, Set<number>>();
  for (const item of portfolio) {
    const key = `portfolio:${item.scope}:${item.measure}`;
    const values = counts.get(key) ?? new Set<number>(); values.add(item.count); counts.set(key, values);
  }
  const conflicts = [...counts].filter(([, values]) => values.size > 1).map(([key]) => key).sort();
  const unknowns = ['portfolio', 'residential_scope', 'operating_footprint', 'maintenance_workflow', 'technology', 'role', 'pain']
    .filter(key => !claims.some(claim => claim.key === key && claim.kind !== 'hypothesis'));
  const projection = { account, claims, routes, portfolio, unknowns, conflicts };
  return { ...projection, fingerprint: accountFingerprint(projection) };
}
