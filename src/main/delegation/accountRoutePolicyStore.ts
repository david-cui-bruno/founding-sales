import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from '../../shared/contracts/accountContract';
import type { AppDatabase } from '../db/database';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import type { Clock } from '../domain/support/clock';
const timezone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } });
export const accountRoutePolicySchema = z.strictObject({
  contact: z.strictObject({ kind: z.enum(['phone','email']), normalizedValue: z.string().min(1).max(2048), validationState: z.enum(['unverified','valid','invalid']),
    evidence: z.strictObject({ federalStatus: z.enum(['unknown','verified_clear','listed']), tcpaFlag: z.boolean().nullable(), coveredAreaCode: z.string().regex(/^\d{3}$/).nullable(),
      source: z.enum(['ftc_download','enrichment_vendor','manual_import','legacy']), scrubbedAt: instant.nullable(), expiresAt: instant.nullable() }) }),
  jurisdiction: z.strictObject({ regionCode: z.string().min(1).max(100), timezone, reviewAt: instant.nullable() }).nullable(),
  clearance: z.strictObject({ decision: z.enum(['unknown','allowed','blocked']), registrationConfirmed: z.boolean().nullable(), stateDncSubscriptionConfirmed: z.boolean().nullable(),
    consentRuleConfirmed: z.boolean().nullable(), effectiveAt: instant, expiresAt: instant.nullable() }).nullable(),
});
export const routePolicyReceiptSchema = z.strictObject({ id, accountId: id, routeId: id, routeVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  canonicalTarget: z.string().min(1).max(2048), evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  evidenceRef: id, evidenceIds: z.array(id).min(1).max(100), provenance: id, observedAt: instant, effectiveAt: instant, expiresAt: instant, policy: accountRoutePolicySchema });
export type RoutePolicyReceipt = z.infer<typeof routePolicyReceiptSchema>;
export class AccountRoutePolicyStore {
  constructor(readonly deps: { database: AppDatabase; clock: Clock; admission?: { attest(receipt: Readonly<RoutePolicyReceipt>): boolean } }) {}
  admit(input: RoutePolicyReceipt): void {
    const value = routePolicyReceiptSchema.parse(input);
    const at = instant.parse(this.deps.clock.now()); const raw = this.deps.database.raw;
    if (raw.inTransaction) throw new Error('Policy admission requires its own transaction');
    raw.transaction(() => {
      if (this.deps.admission?.attest(Object.freeze(structuredClone(value))) !== true) throw new Error('Policy attestation required');
      const fingerprint = accountFingerprint(value);
      const prior = raw.prepare('SELECT receipt_fingerprint FROM pm_account_route_policy_receipts WHERE id=?').get(value.id) as { receipt_fingerprint: string } | undefined;
      if (prior) { if (prior.receipt_fingerprint !== fingerprint) throw new Error('Policy receipt conflict'); return; }
      if (value.observedAt > at || value.effectiveAt > at || value.expiresAt <= at || value.expiresAt <= value.effectiveAt) throw new Error('Policy timestamps invalid');
      if (value.canonicalTarget !== value.policy.contact.normalizedValue) throw new Error('Policy target mismatch');
      const route = raw.prepare('SELECT channel,value FROM pm_account_routes WHERE account_id=? AND id=? AND version=?').get(value.accountId, value.routeId, value.routeVersion) as { channel: string; value: string } | undefined;
      if (!route || route.channel !== value.policy.contact.kind || route.value !== value.canonicalTarget) throw new Error('Policy route mismatch');
      if (new Set(value.evidenceIds).size !== value.evidenceIds.length) throw new Error('Duplicate policy evidence');
      for (const sourceId of [...value.evidenceIds, value.evidenceRef]) {
        if (!raw.prepare('SELECT 1 FROM pm_account_sources WHERE account_id=? AND id=? AND fetched_at<=? AND admitted_at<=?').get(value.accountId, sourceId, value.observedAt, at)) throw new Error('Policy evidence provenance mismatch');
      }
      raw.prepare('INSERT INTO pm_account_route_policy_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.id, value.accountId,
        value.routeId, value.routeVersion, value.canonicalTarget, value.evidenceFingerprint, value.revision, value.evidenceRef, value.provenance,
        value.observedAt, at, value.effectiveAt, value.expiresAt, JSON.stringify(value.policy), fingerprint);
      for (const sourceId of value.evidenceIds) raw.prepare('INSERT INTO pm_account_route_policy_evidence VALUES(?,?,?,?,?)')
        .run(value.accountId, value.routeId, value.routeVersion, value.id, sourceId);
    }).immediate();
  }
}
