import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import type { AppDatabase } from '../../src/main/db/database';
import type { UpdateCallSettingsRequest } from '../../src/shared/contracts/localWorkspaceContract';
function rows(db: AppDatabase, includeSettings = true) {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.filter(t => includeSettings || t.name !== 'meeting_first_call_settings').map(({ name }) => ({ name,
    rows: db.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort() }));
}
async function fixture(scoped = true) {
  const f = await createCampaignFixture(); const ids = { next: randomUUID };
  const services = createDomainServices({ database: f.db, clock: f.clock, ids, expectedWorkspaceId: scoped ? f.workspaceId : undefined });
  const domain = createFounderSalesDomain({ database: f.db, clock: f.clock, ids, services });
  return { ...f, services, domain };
}
describe('Call settings real facade and matching transaction', () => {
  it('uses main time, preserves all other nonempty tables, and rolls back stale, invalid and exhausted revisions', async () => {
    const f = await fixture(); try {
      const beforeRead = rows(f.db); const initial = f.domain.getCallSettings();
      expect(initial).toMatchObject({ newCallSlots: null, totalCallCapacity: null, revision: 0 }); expect(rows(f.db)).toEqual(beforeRead);
      const preserved = rows(f.db, false);
      expect(f.domain.updateCallSettings({ expectedRevision: 0, newCallSlots: 0, totalCallCapacity: 0 })).toEqual({ newCallSlots: 0, totalCallCapacity: 0, revision: 1, updatedAt: f.now });
      expect(rows(f.db, false)).toEqual(preserved);
      const committed = rows(f.db);
      const valid: UpdateCallSettingsRequest = { expectedRevision: 1, newCallSlots: 3, totalCallCapacity: null };
      for (const input of [{ ...valid, expectedRevision: 0 }, { ...valid, newCallSlots: -1 }, { ...valid, totalCallCapacity: 0.5 }, { ...valid, newCallSlots: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, updatedAt: f.now }, { expectedRevision: 1, newCallSlots: null as number | null }]) {
        expect(() => f.domain.updateCallSettings(input as UpdateCallSettingsRequest)).toThrow(); expect(rows(f.db)).toEqual(committed); expect(f.db.raw.inTransaction).toBe(false);
      }
      expect(f.domain.updateCallSettings(valid)).toMatchObject({ revision: 2, newCallSlots: 3, totalCallCapacity: null });
      expect(f.domain.updateCallSettings({ expectedRevision: 2, newCallSlots: null, totalCallCapacity: 0 })).toMatchObject({ revision: 3, newCallSlots: null, totalCallCapacity: 0 });
      const badClock = createFounderSalesDomain({ database: f.db, services: f.services, ids: { next: randomUUID }, clock: { now: () => 'invalid' } });
      const beforeClock = rows(f.db); expect(() => badClock.updateCallSettings({ expectedRevision: 3, newCallSlots: 2, totalCallCapacity: 2 })).toThrow(); expect(rows(f.db)).toEqual(beforeClock);
      f.db.raw.prepare('UPDATE meeting_first_call_settings SET revision = ?').run(Number.MAX_SAFE_INTEGER);
      const exhausted = rows(f.db); expect(f.domain.getCallSettings().revision).toBe(Number.MAX_SAFE_INTEGER);
      expect(() => f.domain.updateCallSettings({ expectedRevision: Number.MAX_SAFE_INTEGER, newCallSlots: 2, totalCallCapacity: 2 })).toThrow(); expect(rows(f.db)).toEqual(exhausted); expect(f.db.raw.inTransaction).toBe(false);
    } finally { f.close(); }
  });
  it('joins real scoped Daily allocation, keeps due obligations above zero capacity and controls only discretionary slots', async () => {
    const f = await fixture(); try {
      f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0].id, campaignVersionId: f.versions[0].id, executionContextId: 'ctx', contextRevision: 1 });
      const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID }, sourcePolicy: { attest: source => source.url === 'https://example.invalid/team' } });
      const cold = accounts.create({ commandId: randomUUID(), name: 'Fictional capacity PM', domain: null }); const source = randomUUID();
      accounts.admitEvidence({ commandId: randomUUID(), accountId: cold.id, expectedVersion: 1, sources: [{ id: source, url: 'https://example.invalid/team', fetchedAt: f.now, sha256: 'c'.repeat(64), excerpt: 'Residential local PM phone', permitted: true }], claims: [{ key: 'residential_scope', kind: 'fact', value: 'residential', evidenceIds: [source] }, { key: 'operating_footprint', kind: 'fact', value: 'local', evidenceIds: [source] }], routes: [{ id: randomUUID(), accountId: cold.id, personId: null, channel: 'phone', value: '+12025550105', purpose: 'business', verification: 'published', evidenceIds: [source] }] });
      const preserved = rows(f.db, false);
      f.domain.updateCallSettings({ expectedRevision: 0, newCallSlots: 1, totalCallCapacity: 1 });
      expect(f.domain.getDaily().calls).toEqual({ accountIds: [f.account.id, cold.id], workloadConflict: true });
      f.domain.updateCallSettings({ expectedRevision: 1, newCallSlots: 0, totalCallCapacity: 0 });
      expect(f.domain.getDaily().calls).toEqual({ accountIds: [f.account.id], workloadConflict: true });
      f.domain.updateCallSettings({ expectedRevision: 2, newCallSlots: null, totalCallCapacity: null });
      expect(f.domain.getDaily().calls).toEqual({ accountIds: [f.account.id], workloadConflict: false }); expect(rows(f.db, false)).toEqual(preserved);
    } finally { f.close(); }
  });
  it('unpaired propagation only: local capacity persists without inventing scope, allocation or execution permission', async () => {
    const f = await fixture(false); try {
      const saved = f.domain.updateCallSettings({ expectedRevision: 0, newCallSlots: 5, totalCallCapacity: 0 }); const daily = f.domain.getDaily();
      expect(daily.callSettings).toEqual({ newCallSlots: saved.newCallSlots, totalCallCapacity: saved.totalCallCapacity }); expect(daily.workspaceId).toBeNull(); expect(daily.accounts).toEqual([]); expect(daily.calls.accountIds).toEqual([]); expect(daily.issues).toContainEqual({ code: 'scope_unknown', count: 1 });
    } finally { f.close(); }
  });
});
