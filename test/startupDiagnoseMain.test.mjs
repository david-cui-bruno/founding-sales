import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('electron'); vi.doUnmock('../src/main/backup/preReleaseBackupRuntime'); vi.doUnmock('../src/main/diagnostics/startupDiagnoseRuntime'); vi.doUnmock('../src/main/startApplication'); });
it('dispatches the diagnose mode without normal lock, renderer protocol, startup, logging or windows and prints one closed reason on refusal', async () => {
  vi.resetModules();
  class Refused extends Error { constructor(reason) { super(`STARTUP_DIAGNOSE_FAILED ${reason}`); this.reason = reason; } }
  const run = vi.fn(async () => { throw new Refused('key'); }); const startup = vi.fn(); const lock = vi.fn(); const exit = vi.fn(); const schemes = vi.fn();
  vi.doMock('electron', () => ({ app: { on: vi.fn(), exit, quit: vi.fn(), requestSingleInstanceLock: lock, isPackaged: true }, protocol: { registerSchemesAsPrivileged: schemes }, BrowserWindow: {}, Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() }, powerMonitor: { on: vi.fn() }, safeStorage: {} }));
  vi.doMock('electron-squirrel-startup', () => ({ default: false }));
  vi.doMock('../src/main/backup/preReleaseBackupRuntime', () => ({ isPreReleaseBackupInvocation: () => false, runPreReleaseBackupHost: vi.fn() }));
  vi.doMock('../src/main/diagnostics/startupDiagnoseRuntime', () => ({ isStartupDiagnoseInvocation: () => true, runStartupDiagnoseHost: run, StartupDiagnoseRefusedError: Refused }));
  vi.doMock('../src/main/startApplication', () => ({ startApplication: startup }));
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined); vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  const written = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((text, done) => { written.push(String(text)); if (typeof done === 'function') done(); return true; });
  try {
    await import('../src/main.ts'); await new Promise(resolve => setImmediate(resolve));
    expect(run).toHaveBeenCalledOnce(); expect(startup).not.toHaveBeenCalled(); expect(lock).not.toHaveBeenCalled(); expect(schemes).not.toHaveBeenCalled();
    expect(written).toEqual(['STARTUP_DIAGNOSE_FAILED key\n']); expect(exit).toHaveBeenCalledWith(1);
  } finally { stderr.mockRestore(); }
});
