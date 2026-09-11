import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));

import { createDiscoveryProvider } from '../../src/main/discovery/discoveryProvider';
import { registerDiscoveryIpc } from '../../src/main/discovery/registerDiscoveryIpc';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createDiscoveryApi } from '../../src/preload/apis/discoveryApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createDiscoveryDatabase, seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

let f: DiscoveryDatabase;
beforeEach(async () => { electron.handle.mockReset(); electron.removeHandler.mockReset(); f = await createDiscoveryDatabase(); });
afterEach(() => { f.close(); });

function bridge() {
  const domain = createFounderSalesDomain({ database: f.database, services: f.services,
    clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID } });
  registerDiscoveryIpc({ provider: createDiscoveryProvider(domain) });
  return createDiscoveryApi(createIpcClient({ invoke: (channel, ...args) => Promise.resolve(
    registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args)) }));
}
const changes = () => f.database.raw.prepare('SELECT total_changes() AS n').get();

describe('discovery provider over the real encrypted domain and IPC/preload', () => {
  it('reads unassessed and prepared owners without writes, qualification, enrichment or actions', async () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'read-only', units: 10 });
    const internalActions = f.database.raw.prepare('SELECT * FROM next_actions ORDER BY id').all();
    const api = bridge();
    const before = changes();
    expect(await api.get()).toMatchObject({ prepared: [], counts: { unassessed: 1 }, researchCapability: 'not_configured' });
    expect(await api.getBrief({ personId: owner.personId })).toMatchObject({ personId: owner.personId, assessment: null });
    expect(changes()).toEqual(before);
    f.services.discovery.assess(owner.prospectId);
    const assessed = changes();
    const snapshot = await api.get();
    expect(snapshot.prepared.map(card => card.personId)).toEqual([owner.personId]);
    expect((await api.getBrief({ personId: owner.personId })).assessment?.axes.fit?.points).toBe(15);
    expect(changes()).toEqual(assessed);
    expect(f.services.identities.getCanonicalProspect(owner.personId)?.qualificationState).toBe('unreviewed');
    expect(f.database.raw.prepare('SELECT * FROM next_actions ORDER BY id').all()).toEqual(internalActions);
    for (const table of ['activities', 'sourcing_enrichment_requests', 'discovery_preparations']) {
      expect(f.database.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('prepares one selected owner and replays the exact UUID receipt without new writes', async () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'selected-ipc', units: 10 });
    const other = seedDiscoveryOwner(f, { prefix: 'untouched-ipc', units: 8 });
    const { assessmentId } = f.services.discovery.assess(owner.prospectId);
    const request = { commandId: randomUUID(), personId: owner.personId, salesCycleId: owner.salesCycleId,
      assessmentId, expectedFingerprint: f.services.discoveryRepository.getCurrent(owner.prospectId)!.fingerprint };
    const api = bridge();
    const receipt = await api.begin(request);
    expect(receipt).toMatchObject({ personId: owner.personId, salesCycleId: owner.salesCycleId, assessmentId,
      mutation: { affectedPersonIds: [owner.personId], affectedSalesCycleIds: [owner.salesCycleId] } });
    expect(f.services.discoveryRepository.getPreparation(request.commandId)).toEqual({ request, receipt });
    const after = changes();
    await expect(api.begin(request)).resolves.toEqual(receipt);
    await expect(api.begin({ ...request, expectedFingerprint: 'f'.repeat(64) })).rejects.toThrow(/conflict/i);
    expect(changes()).toEqual(after);
    expect(f.services.identities.getCanonicalProspect(owner.personId)?.qualificationState).toBe('eligible');
    expect(f.services.identities.getCanonicalProspect(other.personId)?.qualificationState).toBe('unreviewed');
    expect(f.database.raw.prepare("SELECT count(*) AS n FROM next_actions WHERE status='pending'").get()).toEqual({ n: 2 });
    expect(f.database.raw.prepare("SELECT count(*) AS n FROM next_actions WHERE sales_cycle_id=? AND status='pending'").get(owner.salesCycleId)).toEqual({ n: 1 });
    expect(f.database.raw.prepare("SELECT action_type FROM next_actions WHERE sales_cycle_id=? AND status='pending'").get(other.salesCycleId)).toEqual({ action_type: 'review_lead' });
    expect(f.database.raw.prepare('SELECT count(*) AS n FROM activities').get()).toEqual({ n: 0 });
    expect(f.database.raw.prepare('SELECT count(*) AS n FROM sourcing_enrichment_requests').get()).toEqual({ n: 0 });
  });

  it('replays an override UUID and rejects changed fingerprint without changing canonical qualification', async () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'override-ipc', units: 10 });
    const { assessmentId } = f.services.discovery.assess(owner.prospectId);
    const request = { commandId: randomUUID(), personId: owner.personId, assessmentId,
      expectedFingerprint: f.services.discoveryRepository.getCurrent(owner.prospectId)!.fingerprint,
      decision: 'watch' as const, reason: 'Founder context' };
    const api = bridge();
    const receipt = await api.override(request);
    expect(receipt.affectedPersonIds).toEqual([owner.personId]);
    const after = changes();
    await expect(api.override(request)).resolves.toEqual(receipt);
    await expect(api.override({ ...request, expectedFingerprint: 'f'.repeat(64) })).rejects.toThrow(/conflict/i);
    expect((await api.getBrief({ personId: owner.personId })).latestOverride).toMatchObject({ decision: 'watch', reason: 'Founder context' });
    expect(changes()).toEqual(after);
    expect(f.services.identities.getCanonicalProspect(owner.personId)?.qualificationState).toBe('unreviewed');
  });
});
