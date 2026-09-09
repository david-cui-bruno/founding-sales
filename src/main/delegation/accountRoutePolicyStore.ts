import { accountInstantSchema as instant } from '../../shared/contracts/accountContract';
import { routePolicyReceiptSchema, type RoutePolicyReceipt } from '../../shared/contracts/accountRoutePolicyContract';
export { accountRoutePolicySchema, routePolicyReceiptSchema, type RoutePolicyReceipt } from '../../shared/contracts/accountRoutePolicyContract';
import type { AppDatabase } from '../db/database';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import type { Clock } from '../domain/support/clock';
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
