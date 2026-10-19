import { NATIONAL_DNC_COVERED_AREA_CODES, NATIONAL_DNC_UNCHECKED_WARNING, type NationalDncDisclosure } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readPhoneRegistryDecision } from './registryCoverage.ts';
import { readPhoneOfficeProof, type PhoneOfficeProof } from './phoneOfficeProof.ts';

export interface OwnerRiskReceipt {
  [key: string]: unknown; id: string; owner_user_id: string; recorded_at: Date; valid_until: Date | null;
  revoked_at: Date | null; self_test_firm_id: string | null; self_test_e164: string | null; self_test_erased_at: Date | null;
}
export type PhoneNationalDecision =
  | { ok: false; reason: 'dnc_coverage_unknown' | 'dnc_registry_match' }
  | { ok: true; basis: 'registry'; at: string; freshUntil: string; snapshotId: string; scrubbedAt: string; disclosure: NationalDncDisclosure }
  | { ok: true; basis: 'office_owner_risk' | 'owner_self_test'; at: string; freshUntil: string; receipt: OwnerRiskReceipt;
      proof: PhoneOfficeProof | null; disclosure: NationalDncDisclosure };

export const ownerRiskDisclosure = (receiptId: string, selfTest: boolean): NationalDncDisclosure => ({
  status: 'not_checked_owner_risk', basis: selfTest ? 'owner_self_test' : 'verified_business_office',
  receiptId, warning: NATIONAL_DNC_UNCHECKED_WARNING,
});

export async function readOwnerRiskReceipt(context: RepositoryContext, at: string): Promise<OwnerRiskReceipt | null> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return null;
  const receipt = (await context.db.query<OwnerRiskReceipt>(`SELECT id,owner_user_id,recorded_at,valid_until,revoked_at,
    self_test_firm_id,self_test_e164,self_test_erased_at FROM phone_owner_risk_receipts
    WHERE workspace_id=$1 AND owner_user_id=$2 FOR SHARE`, [context.scope.workspaceId, actor.userId])).rows[0];
  if (!receipt || receipt.revoked_at || receipt.recorded_at.getTime() > Date.parse(at) ||
      (receipt.valid_until && receipt.valid_until.getTime() <= Date.parse(at))) return null;
  const membership = (await context.db.query<{ role: string; status: string }>(
    'SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [context.scope.workspaceId, actor.userId])).rows[0];
  return membership?.role === 'admin' && membership.status === 'active' ? receipt : null;
}

/** Only unknown coverage of a permanently uncovered code can enter owner-risk policy. */
export async function readPhoneNationalDecision(context: RepositoryContext, input: {
  firmId: string; routeId: string; routeVersion: number; e164: string; at?: string;
}): Promise<PhoneNationalDecision> {
  const registry = await readPhoneRegistryDecision(context, input.e164, input.at);
  if (registry.ok) return { ...registry, basis: 'registry', disclosure: { status: 'checked_clear', basis: 'registry', receiptId: null, warning: null } };
  if (registry.reason !== 'dnc_coverage_unknown' || !/^\+1[2-9][0-9]{9}$/u.test(input.e164) ||
      (NATIONAL_DNC_COVERED_AREA_CODES as readonly string[]).includes(input.e164.slice(2, 5))) return registry;
  // Retained known matches remain restrictive even if a later incomplete snapshot obscures them.
  const match = await context.db.query(`SELECT 1 FROM national_registry_endpoint_scrubs WHERE workspace_id=$1 AND e164=$2 AND result='match' LIMIT 1`,
    [context.scope.workspaceId, input.e164]);
  if (match.rows.length) return { ok: false, reason: 'dnc_registry_match' };
  const clock = (await context.db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]?.at;
  const at = input.at ?? clock?.toISOString();
  if (!at) return registry;
  const receipt = await readOwnerRiskReceipt(context, at);
  if (!receipt) return registry;
  const selfTest = receipt.self_test_erased_at === null && receipt.self_test_firm_id === input.firmId && receipt.self_test_e164 === input.e164;
  if (!selfTest && (receipt.self_test_firm_id === input.firmId || receipt.self_test_e164 === input.e164)) return registry;
  if (selfTest) {
    const consumed = await context.db.query(`SELECT 1 FROM phone_handoff_attempts WHERE workspace_id=$1 AND owner_risk_receipt_id=$2 AND national_dnc_basis='owner_self_test'`,
      [context.scope.workspaceId, receipt.id]);
    if (consumed.rows.length) return registry;
  }
  const proof = selfTest ? null : await readPhoneOfficeProof(context, { ...input, at });
  if (!selfTest && !proof) return registry;
  const freshUntil = new Date(Math.min(receipt.valid_until?.getTime() ?? Infinity,
    proof ? Date.parse(proof.expiresAt) : Date.parse(at) + 15_000)).toISOString();
  return { ok: true, basis: selfTest ? 'owner_self_test' : 'office_owner_risk', at, freshUntil, receipt, proof,
    disclosure: ownerRiskDisclosure(receipt.id, selfTest) };
}
