import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { AccountRoutePolicyStore, type RoutePolicyReceipt } from '../../src/main/delegation/accountRoutePolicyStore';
import { readRouteJurisdictionTimezones } from '../../src/main/domain/today/routeJurisdiction';

describe('readRouteJurisdictionTimezones', () => {
  it('reads the latest receipt zone per firm, skips receipts without a jurisdiction, and never throws on a malformed one', async () => {
    const f = await createCampaignFixture();
    try {
      const sourceId = f.db.raw.prepare('SELECT id FROM pm_account_sources WHERE account_id=?').get(f.account.id) as { id: string };
      const store = new AccountRoutePolicyStore({ database: f.db, clock: f.clock, admission: { attest: () => true } });
      const receipt = (revision: number, jurisdiction: RoutePolicyReceipt['policy']['jurisdiction'], routeIndex = 0): RoutePolicyReceipt => ({
        id: randomUUID(), accountId: f.account.id, routeId: f.routes[routeIndex]!.id, routeVersion: 1, canonicalTarget: f.routes[routeIndex]!.value,
        evidenceFingerprint: 'a'.repeat(64), revision, evidenceRef: sourceId.id, evidenceIds: [sourceId.id], provenance: 'fictional-attestor',
        observedAt: f.now, effectiveAt: f.now, expiresAt: '2027-01-01T00:00:00.000Z',
        policy: { contact: { kind: 'phone', normalizedValue: f.routes[routeIndex]!.value, validationState: 'valid',
          evidence: { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '202', source: 'manual_import', scrubbedAt: null, expiresAt: null } },
        jurisdiction, clearance: null },
      });
      expect(readRouteJurisdictionTimezones(f.db, [f.account.id, 'absent'])).toEqual(new Map());
      store.admit(receipt(1, { regionCode: 'RI', timezone: 'America/New_York', reviewAt: null }));
      expect(readRouteJurisdictionTimezones(f.db, [f.account.id])).toEqual(new Map([[f.account.id, 'America/New_York']]));
      // A later revision wins, even on another route of the same firm.
      store.admit(receipt(2, { regionCode: 'TX', timezone: 'America/Chicago', reviewAt: null }, 1));
      expect(readRouteJurisdictionTimezones(f.db, [f.account.id])).toEqual(new Map([[f.account.id, 'America/Chicago']]));
      // The newest receipt without a jurisdiction leaves the firm unmapped so the caller falls back to the workspace zone.
      store.admit(receipt(3, null, 1));
      expect(readRouteJurisdictionTimezones(f.db, [f.account.id])).toEqual(new Map());
      // Stored receipts are immutable, so a newest receipt with an unusable zone is written directly (the contract would never admit it).
      f.db.raw.prepare('INSERT INTO pm_account_route_policy_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), f.account.id, f.routes[1]!.id, 1, f.routes[1]!.value,
        'a'.repeat(64), 4, sourceId.id, 'fictional-attestor', f.now, f.now, f.now, '2027-01-01T00:00:00.000Z',
        JSON.stringify({ contact: {}, jurisdiction: { regionCode: 'XX', timezone: 'Not/AZone', reviewAt: null }, clearance: null }), 'c'.repeat(64));
      expect(readRouteJurisdictionTimezones(f.db, [f.account.id])).toEqual(new Map());
      f.db.raw.prepare('INSERT INTO pm_account_route_policy_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), f.account.id, f.routes[1]!.id, 1, f.routes[1]!.value,
        'a'.repeat(64), 5, sourceId.id, 'fictional-attestor', f.now, f.now, f.now, '2027-01-01T00:00:00.000Z',
        JSON.stringify({ contact: {}, jurisdiction: 'not-an-object', clearance: null }), 'd'.repeat(64));
      expect(readRouteJurisdictionTimezones(f.db, [f.account.id])).toEqual(new Map());
      expect(readRouteJurisdictionTimezones(f.db, [])).toEqual(new Map());
    } finally { f.close(); }
  });
});
