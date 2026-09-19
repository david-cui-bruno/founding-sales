import { describe, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { registerDailyIpc } from '../../src/main/today/registerDailyIpc';
import { createDailyApi } from '../../src/preload/apis/dailyApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { buildDailySnapshot } from '../../src/main/domain/today/dailyProjection';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createDailyProvider } from '../../src/main/ipc/registerApplicationIpc';
const snapshot = () => buildDailySnapshot({ workspaceId: null, generatedAt: '2026-09-09T12:00:00.000Z', accounts: [], calls: { accountIds: [], workloadConflict: false }, approvals: [], ownerStatus: [], issues: [], campaigns: [], callSettings: { newCallSlots: null, totalCallCapacity: null }, transport: [] });
describe('daily read IPC', () => {
  it('roundtrips through validated bridge, rejects input and untrusted callers, cleans up once', async () => {
    const remove = registerDailyIpc({ get: async () => snapshot() });
    const handler = registeredIpcHandler(electron.handle, 'daily:get');
    const trusted = { senderFrame: { url: 'callie://app/index.html' } };
    const api = createDailyApi(createIpcClient({ invoke: async (_channel, ...args) => handler(trusted, ...args) }));
    expect(await api.get()).toEqual(snapshot());
    await expect(handler(trusted, { workspaceId: 'other' })).rejects.toThrow();
    await expect(handler({ senderFrame: { url: 'https://evil.invalid' } })).rejects.toThrow();
    remove(); remove(); expect(electron.removeHandler).toHaveBeenCalledTimes(1);
  });
  it('validates responses and traverses the lifecycle gate on every read', async () => {
    let reads = 0;
    const provider = createDailyProvider({ withDomain: async (operation: (domain: unknown) => unknown) => { reads++; return operation({ getDaily: snapshot }); } } as never);
    expect(await provider.get()).toEqual(snapshot()); expect(await provider.get()).toEqual(snapshot()); expect(reads).toBe(2);
    const api = createDailyApi(createIpcClient({ invoke: async () => ({ ...snapshot(), unexpected: true }) }));
    await expect(api.get()).rejects.toThrow();
  });
});
