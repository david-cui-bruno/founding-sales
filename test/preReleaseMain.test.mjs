import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('electron'); vi.doUnmock('../src/main/backup/preReleaseBackupRuntime'); vi.doUnmock('../src/main/startApplication'); });
it('dispatches the reserved headless mode without normal lock, renderer protocol, startup, logging or windows', async () => {
  vi.resetModules(); const run = vi.fn(async () => { throw new Error('private'); }); const startup = vi.fn(); const lock = vi.fn(); const exit = vi.fn(); const schemes = vi.fn();
  vi.doMock('electron', () => ({ app: { on: vi.fn(), exit, quit: vi.fn(), requestSingleInstanceLock: lock, isPackaged: true }, protocol: { registerSchemesAsPrivileged: schemes }, BrowserWindow: {}, Menu: {}, safeStorage: {} }));
  vi.doMock('electron-squirrel-startup', () => ({ default: false }));
  vi.doMock('../src/main/backup/preReleaseBackupRuntime', () => ({ isPreReleaseBackupInvocation: () => true, runPreReleaseBackupHost: run }));
  vi.doMock('../src/main/startApplication', () => ({ startApplication: startup }));
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined); vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((_text, done) => { if (typeof done === 'function') done(); return true; });
  try { await import('../src/main.ts'); await new Promise(resolve => setImmediate(resolve)); expect(run).toHaveBeenCalledOnce(); expect(startup).not.toHaveBeenCalled(); expect(lock).not.toHaveBeenCalled(); expect(schemes).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledWith(1); expect(stderr).toHaveBeenCalledWith('PRE_RELEASE_BACKUP_FAILED\n', expect.any(Function)); }
  finally { stderr.mockRestore(); }
});
