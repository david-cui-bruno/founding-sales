import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));

import { registerDiscoveryIpc } from '../../src/main/discovery/registerDiscoveryIpc';
import { createDiscoveryApi } from '../../src/preload/apis/discoveryApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import type { BeginDiscoveryRequest, DiscoveryApi, DiscoveryBrief, DiscoverySnapshot } from '../../src/shared/contracts/discoveryContract';
import { registeredIpcHandler, type IpcInvokeEvent } from '../fixtures/registeredIpcHandler';

const trustedEvent: IpcInvokeEvent = { senderFrame: { url: 'callie://app/index.html' } };
const untrustedEvent: IpcInvokeEvent = { senderFrame: { url: 'https://attacker.test/' } };
const channels = ['discovery:get', 'discovery:get-brief', 'discovery:begin', 'discovery:override'];
const request: BeginDiscoveryRequest = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  personId: 'person-1', salesCycleId: 'cycle-1', assessmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expectedFingerprint: 'a'.repeat(64) };
const overrideRequest = { commandId: request.commandId, personId: request.personId,
  assessmentId: request.assessmentId, expectedFingerprint: request.expectedFingerprint,
  decision: 'watch' as const, reason: 'Founder context' };
const mutation = { revision: 1, affectedPersonIds: ['person-1'], affectedSalesCycleIds: ['cycle-1'] };
const receipt = { mutation, personId: 'person-1', salesCycleId: 'cycle-1',
  assessmentId: request.assessmentId, actionId: 'action-1' };
const brief: DiscoveryBrief = { personId: 'person-1', salesCycleId: 'cycle-1', personName: 'Synthetic Owner',
  assessment: null, stale: false, latestOverride: null, pilotNextStep: null };
const snapshot: DiscoverySnapshot = { prepared: [brief], judgment: [],
  counts: { unassessed: 1, research: 0, watch: 0, excluded: 0 }, processing: 'idle',
  researchCapability: 'not_configured', generatedAt: '2026-09-06T12:00:00.000Z', revision: 0 };
const providerFor = () => ({ get: vi.fn(async () => snapshot), getBrief: vi.fn(async () => brief),
  begin: vi.fn(async () => receipt), override: vi.fn(async () => mutation) });
const invokeRegistered = (channel: string, event: IpcInvokeEvent, ...args: unknown[]) =>
  Promise.resolve(registeredIpcHandler(electron.handle, channel)(event, ...args));
const apiFor = () => createDiscoveryApi(createIpcClient({
  invoke: (channel, ...args) => invokeRegistered(channel, trustedEvent, ...args),
}));

beforeEach(() => { electron.handle.mockReset(); electron.removeHandler.mockReset(); });

describe('registered discovery boundary through the actual preload client', () => {
  it('registers only four channels and carries exact requests and receipts through the real bridge', async () => {
    const provider = providerFor();
    const unregister = registerDiscoveryIpc({ provider });
    expect(electron.handle.mock.calls.map(([channel]) => channel)).toEqual(channels);
    const api = apiFor();
    await expect(api.get()).resolves.toEqual(snapshot);
    await expect(api.getBrief({ personId: 'person-1' })).resolves.toEqual(brief);
    await expect(api.begin(request)).resolves.toEqual(receipt);
    await expect(api.override(overrideRequest)).resolves.toEqual(mutation);
    expect(provider.begin).toHaveBeenCalledWith(request);
    expect(provider.override).toHaveBeenCalledWith(overrideRequest);
    unregister(); unregister();
    expect(electron.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([...channels].reverse());
  });

  it('accepts exactly ten unique prepared Persons without truncation', async () => {
    const provider = providerFor(); registerDiscoveryIpc({ provider });
    const full = { ...snapshot, prepared: Array.from({ length: 10 }, (_, i) => ({ ...brief, personId: `person-${i}` })) };
    provider.get.mockResolvedValue(full);
    await expect(apiFor().get()).resolves.toEqual(full);
  });

  it.each(channels)('refuses an untrusted renderer on %s before calling the provider', async channel => {
    const provider = providerFor(); registerDiscoveryIpc({ provider });
    const args = channel === 'discovery:get' ? [] : [channel === 'discovery:get-brief'
      ? { personId: 'person-1' } : channel === 'discovery:begin' ? request : overrideRequest];
    await expect(invokeRegistered(channel, untrustedEvent, ...args)).rejects.toThrow();
    for (const method of Object.values(provider)) expect(method).not.toHaveBeenCalled();
  });

  it('honors the injected trust predicate', async () => {
    registerDiscoveryIpc({ provider: providerFor(), isTrustedRendererUrl: url => url === 'fixture://trusted' });
    await expect(invokeRegistered('discovery:get', trustedEvent)).rejects.toThrow();
    await expect(invokeRegistered('discovery:get', { senderFrame: { url: 'fixture://trusted' } })).resolves.toEqual(snapshot);
  });

  it.each([undefined, {}, null])('refuses even an explicit %s payload for no-input get', async payload => {
    const provider = providerFor(); registerDiscoveryIpc({ provider });
    await expect(invokeRegistered('discovery:get', trustedEvent, payload)).rejects.toThrow();
    expect(provider.get).not.toHaveBeenCalled();
  });

  it.each([
    ['discovery:get-brief', { personId: 'person-1' }],
    ['discovery:begin', request], ['discovery:override', overrideRequest],
  ])('requires exactly one strict request on %s', async (channel, input) => {
    const provider = providerFor(); registerDiscoveryIpc({ provider });
    await expect(invokeRegistered(channel as string, trustedEvent)).rejects.toThrow();
    await expect(invokeRegistered(channel as string, trustedEvent, input, input)).rejects.toThrow();
    await expect(invokeRegistered(channel as string, trustedEvent, { ...input as object, unexpected: true })).rejects.toThrow();
    for (const method of Object.values(provider)) expect(method).not.toHaveBeenCalled();
  });

  it.each([{ commandId: 'not-a-uuid' }, { assessmentId: 'not-a-uuid' },
    { expectedFingerprint: 'A'.repeat(64) }])('rejects noncanonical mutation identity %j', async invalid => {
    const provider = providerFor(); registerDiscoveryIpc({ provider });
    await expect(invokeRegistered('discovery:begin', trustedEvent, { ...request, ...invalid })).rejects.toThrow();
    await expect(invokeRegistered('discovery:override', trustedEvent, { ...overrideRequest, ...invalid })).rejects.toThrow();
    expect(provider.begin).not.toHaveBeenCalled(); expect(provider.override).not.toHaveBeenCalled();
  });

  it('rejects a schema-valid brief owned by a different requested Person', async () => {
    const provider = providerFor(); registerDiscoveryIpc({ provider });
    provider.getBrief.mockResolvedValue({ ...brief, personId: 'other-person' });
    await expect(invokeRegistered('discovery:get-brief', trustedEvent, { personId: 'person-1' })).rejects.toThrow();
  });

  it.each(['personId', 'salesCycleId', 'assessmentId', 'mutationPerson', 'mutationCycle'] as const)(
    'refuses a mismatched begin %s at the registered handler', async key => {
      const provider = providerFor(); registerDiscoveryIpc({ provider });
      const changed = structuredClone(receipt);
      if (key === 'personId') { changed.personId = 'other-person'; changed.mutation.affectedPersonIds = ['other-person']; }
      if (key === 'salesCycleId') { changed.salesCycleId = 'other-cycle'; changed.mutation.affectedSalesCycleIds = ['other-cycle']; }
      if (key === 'assessmentId') changed.assessmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      if (key === 'mutationPerson') changed.mutation.affectedPersonIds = ['other-person'];
      if (key === 'mutationCycle') changed.mutation.affectedSalesCycleIds = ['other-cycle'];
      provider.begin.mockResolvedValue(changed);
      await expect(invokeRegistered('discovery:begin', trustedEvent, request)).rejects.toThrow();
      await expect(apiFor().begin(request)).rejects.toThrow();
    });

  it('refuses an override mutation owned by a different Person', async () => {
    const provider = providerFor(); registerDiscoveryIpc({ provider });
    provider.override.mockResolvedValue({ ...mutation, affectedPersonIds: ['other-person'] });
    await expect(invokeRegistered('discovery:override', trustedEvent, overrideRequest)).rejects.toThrow();
  });

  it.each(['duplicate prepared', 'duplicate judgment', 'cross bucket', 'over cap', 'unknown field'])(
    'rejects invalid snapshot: %s', async invalid => {
      const provider = providerFor(); registerDiscoveryIpc({ provider });
      const changed = { ...snapshot,
        ...(invalid === 'duplicate prepared' ? { prepared: [brief, brief] } : {}),
        ...(invalid === 'duplicate judgment' ? { prepared: [], judgment: [brief, brief] } : {}),
        ...(invalid === 'cross bucket' ? { judgment: [brief] } : {}),
        ...(invalid === 'over cap' ? { prepared: Array.from({ length: 11 }, (_, i) => ({ ...brief, personId: `p-${i}` })) } : {}),
        ...(invalid === 'unknown field' ? { surprise: true } : {}),
      };
      provider.get.mockResolvedValue(changed);
      await expect(invokeRegistered('discovery:get', trustedEvent)).rejects.toThrow();
    });

  it.each(['getBrief', 'begin', 'override'] as const)('rejects unknown response fields for %s', async method => {
    const provider: DiscoveryApi = { ...providerFor(), [method]: async () => ({
      ...(method === 'getBrief' ? brief : method === 'begin' ? receipt : mutation), surprise: true,
    }) };
    registerDiscoveryIpc({ provider });
    const channel = method === 'getBrief' ? 'discovery:get-brief' : `discovery:${method}`;
    await expect(invokeRegistered(channel, trustedEvent, method === 'getBrief'
      ? { personId: 'person-1' } : method === 'begin' ? request : overrideRequest)).rejects.toThrow();
  });

  it.each([1, 2, 3, 4])('rolls back only successful registrations when handler %s fails', nth => {
    const owned = new Set(['unrelated']); let count = 0;
    const failure = new Error('registration failure');
    electron.handle.mockImplementation((channel: string) => { if (++count === nth) throw failure; owned.add(channel); });
    electron.removeHandler.mockImplementation((channel: string) => { owned.delete(channel); });
    expect(() => registerDiscoveryIpc({ provider: providerFor() })).toThrow(failure);
    expect([...owned]).toEqual(['unrelated']);
    expect(electron.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(channels.slice(0, nth - 1).reverse());
  });

  it('finishes cleanup after a removal error and is idempotent', () => {
    const cleanupError = new Error('cleanup');
    const dispose = registerDiscoveryIpc({ provider: providerFor() });
    electron.removeHandler.mockImplementation((channel: string) => { if (channel === 'discovery:override') throw cleanupError; });
    expect(dispose).toThrow(AggregateError);
    expect(electron.removeHandler).toHaveBeenCalledTimes(4);
    expect(dispose).not.toThrow();
    expect(electron.removeHandler).toHaveBeenCalledTimes(4);
  });

  it('preserves registration and rollback errors while cleaning every owned handler', () => {
    const failure = new Error('register'); const cleanup = new Error('cleanup');
    electron.handle.mockImplementation((channel: string) => { if (channel === 'discovery:override') throw failure; });
    electron.removeHandler.mockImplementation((channel: string) => { if (channel === 'discovery:begin') throw cleanup; });
    let caught: unknown;
    try { registerDiscoveryIpc({ provider: providerFor() }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([failure, cleanup]);
    expect((caught as AggregateError).cause).toBe(failure);
    expect(electron.removeHandler).toHaveBeenCalledTimes(3);
  });
});
