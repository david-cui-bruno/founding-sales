import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryProvider } from '../../src/shared/contracts/recoveryContract';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { registerRecoveryIpc } from '../../src/main/recovery/registerRecoveryIpc';
const status: import('../../src/shared/contracts/recoveryContract').RecoveryReadinessStatus = { setupCompletedAt: null, lastRestoreDrillAt: null, outreachReady: false, backup: { status: 'missing' as const, createdAt: null, verifiedAt: null } };
const session = { sessionId: 'synthetic-id', material: 'synthetic-secret', generatedAt: '2026-09-06T12:00:00.000Z' };
const trusted = { senderFrame: { url: 'callie://app/index.html' } };
describe('recovery IPC boundary', () => {
  let provider: RecoveryProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = { status: vi.fn(async () => status), beginSetup: vi.fn(async () => session), saveSetupMaterial: vi.fn(async () => ({ kind: 'cancelled' as const })), completeSetup: vi.fn(async () => status), selectAndRunRestoreDrill: vi.fn(async () => ({ kind: 'cancelled' as const })) };
  });
  function handler(channel: string) { return electron.handle.mock.calls.find(([name]) => name === channel)![1]; }
  it('registers exactly five strict channels and removes once', async () => {
    const unregister = registerRecoveryIpc(provider);
    expect(electron.handle.mock.calls.map(([name]) => name).sort()).toEqual(['recovery:begin-setup', 'recovery:complete-setup', 'recovery:save-setup-material', 'recovery:select-and-run-restore-drill', 'recovery:status']);
    expect(await handler('recovery:status')(trusted)).toEqual(status);
    expect(await handler('recovery:begin-setup')(trusted, { founderConfirmed: true })).toEqual(session);
    unregister(); unregister(); expect(electron.removeHandler.mock.calls).toHaveLength(5);
  });
  it('sanitizes trust, arity, unknown keys and invalid nested responses before exposing errors', async () => {
    registerRecoveryIpc(provider);
    for (const args of [[{ senderFrame: { url: 'https://evil.invalid' } }, { founderConfirmed: true }], [trusted], [trusted, { founderConfirmed: true }, {}], [trusted, { founderConfirmed: true, 'synthetic-secret': '/private/path' }], [trusted, { founderConfirmed: false }]]) {
      await expect(handler('recovery:begin-setup')(...args)).rejects.toThrow(/^RECOVERY_FAILED$/);
    }
    expect(provider.beginSetup).not.toHaveBeenCalled();
    await expect(handler('recovery:status')(trusted, {})).rejects.toThrow(/^RECOVERY_FAILED$/);
    vi.mocked(provider.status).mockResolvedValue({ ...status, backup: { ...status.backup, material: 'synthetic-secret' } } as never);
    await expect(handler('recovery:status')(trusted)).rejects.toThrow(/^RECOVERY_FAILED$/);
    vi.mocked(provider.beginSetup).mockRejectedValue(new Error('synthetic-secret /private/path'));
    await expect(handler('recovery:begin-setup')(trusted, { founderConfirmed: true })).rejects.toThrow(/^RECOVERY_FAILED$/);
  });
  it('accepts only closed supplied-material requests without paths', async () => {
    registerRecoveryIpc(provider);
    const invoke = handler('recovery:select-and-run-restore-drill');
    for (const request of [{ founderConfirmed: true }, { founderConfirmed: true, materialSource: 'file', recoveryMaterial: 'secret' }, { founderConfirmed: true, materialSource: 'paste', recoveryMaterial: 'secret', path: '/secret' }]) {
      await expect(invoke(trusted, request)).rejects.toThrow(/^RECOVERY_FAILED$/);
    }
    expect(provider.selectAndRunRestoreDrill).not.toHaveBeenCalled();
    expect(await invoke(trusted, { founderConfirmed: true, materialSource: 'paste', recoveryMaterial: 'supplied' })).toEqual({ kind: 'cancelled' });
  });
});
