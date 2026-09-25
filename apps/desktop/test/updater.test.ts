import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadVerifiedArtifact, type UpdateDecision } from '../src/main/updateChannel.ts';
import { createUpdater, nodeUpdateFiles, systemCommandRunner } from '../src/main/updateInstall.ts';
import { UPDATE_IPC_CHANNELS } from '../src/shared/updateContract.ts';
import { CHANNEL, TEAM, createFakeTools, fakeZip, manifestFor, realBundleStore } from './support/updateFakes.ts';

/**
 * Lane g83: the Electron side of the updater, and the real ports under it.
 *
 * `updater.ts` is the one update file that imports Electron, so Electron is replaced here
 * by the handful of calls it makes. What this proves is the wiring the brief turns on:
 * the check runs at once when the watch starts — at launch — as well as on the interval;
 * the page's two channels answer; a state change reaches every window. Then the real
 * `node:fs` port and the real command runner, on a temporary directory, including the
 * whole swap with real renames.
 */

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: string[] = [];
  const paths: Record<string, string> = {};
  return {
    handlers,
    sent,
    paths,
    relaunch: vi.fn(),
    exit: vi.fn(),
    showMessageBox: vi.fn(async () => await Promise.resolve({ response: 0 })),
    showItemInFolder: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => electron.paths[name] ?? `/nonexistent/${name}`,
    relaunch: electron.relaunch,
    exit: electron.exit,
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string) => { electron.sent.push(channel); } } },
    ],
  },
  dialog: { showMessageBox: electron.showMessageBox },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler);
    },
  },
  shell: { showItemInFolder: electron.showItemInFolder },
}));

const { startUpdateWatch } = await import('../src/main/updater.ts');

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fss-g83-'));
  electron.handlers.clear();
  electron.sent.length = 0;
  electron.paths['userData'] = join(root, 'userData');
  electron.paths['downloads'] = join(root, 'Downloads');
  // Not inside an `.app`: a development run, which installs nothing.
  electron.paths['exe'] = join(root, 'bin', 'electron');
  electron.relaunch.mockClear();
  electron.exit.mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('startUpdateWatch', () => {
  const watching = (intervalMs: number, checks: string[]): ReturnType<typeof startUpdateWatch> =>
    startUpdateWatch({
      currentVersion: '1.0.5',
      channelBaseUrl: CHANNEL,
      publicKey: 'compiled-in',
      blocked: async () => await Promise.resolve(false),
      intervalMs,
      check: async input => {
        checks.push(input.currentVersion);
        return await Promise.resolve({ kind: 'up_to_date' } as const);
      },
    });

  it('checks the channel at once — at launch — without waiting for the interval', async () => {
    const checks: string[] = [];
    // An hour: nothing but the launch check can happen inside this test.
    const watch = watching(60 * 60 * 1000, checks);
    try {
      await expect(watch.launch).resolves.toEqual({ kind: 'nothing', decision: { kind: 'up_to_date' } });
      expect(checks).toEqual(['1.0.5']);
      // The launch recorded this start in userData before it asked the channel.
      const launched = JSON.parse(await readFile(join(root, 'userData', 'updates', 'launched.json'), 'utf8')) as unknown;
      expect(launched).toMatchObject({ format: 'fss-desktop-launched', version: '1.0.5' });
    } finally {
      watch.stop();
    }
  });

  it('hands the check this Mac’s macOS version, and none outside Electron (lane g86)', async () => {
    const seen: string[] = [];
    const told = startUpdateWatch({
      currentVersion: '1.0.5',
      systemVersion: '15.4.1',
      channelBaseUrl: CHANNEL,
      publicKey: 'compiled-in',
      blocked: async () => await Promise.resolve(false),
      check: async input => {
        seen.push(input.systemVersion);
        return await Promise.resolve({ kind: 'up_to_date' } as const);
      },
    });
    await told.launch;
    told.stop();
    // Plain Node has no `process.getSystemVersion`: the empty string, which the channel
    // refuses as unreadable, never a guess that the Mac is new enough.
    const defaulted = startUpdateWatch({
      currentVersion: '1.0.5',
      channelBaseUrl: CHANNEL,
      publicKey: 'compiled-in',
      blocked: async () => await Promise.resolve(false),
      check: async input => {
        seen.push(input.systemVersion);
        return await Promise.resolve({ kind: 'up_to_date' } as const);
      },
    });
    await defaulted.launch;
    defaulted.stop();
    expect(seen).toEqual(['15.4.1', '']);
  });

  it('keeps the periodic check', async () => {
    const checks: string[] = [];
    const watch = watching(25, checks);
    try {
      await watch.launch;
      await vi.waitFor(() => { expect(checks.length).toBeGreaterThanOrEqual(3); }, { timeout: 3_000 });
    } finally {
      watch.stop();
    }
    // Restart waits for whatever the last tick started, so it finishes before the directory goes.
    await watch.restart();
  });

  it('answers the page’s two channels, which take no argument', async () => {
    const watch = startUpdateWatch({
      currentVersion: '1.0.5',
      channelBaseUrl: CHANNEL,
      publicKey: 'compiled-in',
      blocked: async () => await Promise.resolve(false),
      check: async () => await Promise.resolve({ kind: 'up_to_date' } as const),
    });
    try {
      await watch.launch;
      expect([...electron.handlers.keys()].sort()).toEqual([UPDATE_IPC_CHANNELS.restart, UPDATE_IPC_CHANNELS.state].sort());
      expect(await electron.handlers.get(UPDATE_IPC_CHANNELS.state)?.({}, { anything: 'ignored' })).toEqual({ kind: 'none' });
      expect(await electron.handlers.get(UPDATE_IPC_CHANNELS.restart)?.({}, { version: '9.9.9' })).toEqual({ kind: 'none' });
      expect(electron.relaunch).not.toHaveBeenCalled();
    } finally {
      watch.stop();
    }
  });

  it('tells every window when the state changes, and keeps the refusal dialog', async () => {
    const zip = fakeZip({ version: '1.0.6', team: TEAM });
    const manifest = manifestFor(zip, '1.0.6');
    const told: string[] = [];
    const watch = startUpdateWatch({
      currentVersion: '1.0.5',
      channelBaseUrl: CHANNEL,
      publicKey: 'compiled-in',
      blocked: async () => await Promise.resolve(false),
      check: async () => await Promise.resolve({ kind: 'available', manifest } as const),
      download: async () => await Promise.resolve({ ok: false, reason: 'update_artifact_digest_mismatch' } as const),
      tell: async message => {
        told.push(message);
        await Promise.resolve();
      },
    });
    try {
      await expect(watch.launch).resolves.toMatchObject({ kind: 'refused', reason: 'update_artifact_digest_mismatch' });
      expect(told).toEqual(['Callie could not verify the update']);
      // Installing, then nothing: two pings, and each carries nothing but the channel name.
      expect(electron.sent).toEqual([UPDATE_IPC_CHANNELS.changed, UPDATE_IPC_CHANNELS.changed]);
      expect(electron.relaunch).not.toHaveBeenCalled();
    } finally {
      watch.stop();
    }
  });

  it('is started by main.ts right after start(...), with the version gate as the blocked signal', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const started = source.indexOf('const manager = await start({');
    const watched = source.indexOf('startUpdateWatch({', started);
    expect(started).toBeGreaterThan(0);
    expect(watched).toBeGreaterThan(started);
    expect(source.slice(watched)).toContain("blocked: async () => (await manager.state()).screen === 'upgrade_required'");
  });
});

describe('the real ports', () => {
  it('node:fs: kinds, lists, records and removals', async () => {
    const files = nodeUpdateFiles();
    const directory = join(root, 'd');
    await files.makeDirectory(join(directory, 'nested'));
    await writeFile(join(directory, 'file'), 'x');
    await symlink(join(directory, 'file'), join(directory, 'link'));

    expect(await files.kind(join(directory, 'nested'))).toBe('directory');
    expect(await files.kind(join(directory, 'file'))).toBe('file');
    expect(await files.kind(join(directory, 'link'))).toBe('symlink');
    expect(await files.kind(join(directory, 'absent'))).toBeNull();
    expect(await files.list(join(directory, 'absent'))).toEqual([]);
    expect(await files.readText(join(directory, 'absent'))).toBeNull();
    expect(await files.readBytes(join(directory, 'absent'))).toBeNull();

    await files.writeText(join(directory, 'record.json'), '{"a":1}\n');
    expect(await files.readText(join(directory, 'record.json'))).toBe('{"a":1}\n');
    // Written beside and renamed over: no temporary file is left behind.
    expect((await readdir(directory)).sort()).toEqual(['file', 'link', 'nested', 'record.json']);
    expect((await stat(join(directory, 'record.json'))).mode & 0o777).toBe(0o600);

    await files.writeBytes(join(directory, 'bytes'), new Uint8Array([1, 2, 3]));
    expect(await files.readBytes(join(directory, 'bytes'))).toEqual(new Uint8Array([1, 2, 3]));
    expect((await stat(join(directory, 'bytes'))).mode & 0o777).toBe(0o600);

    // rename(2) refuses to put a directory over one that is not empty.
    await files.makeDirectory(join(directory, 'full', 'inside'));
    await files.makeDirectory(join(directory, 'other', 'inside'));
    await expect(files.rename(join(directory, 'other'), join(directory, 'full'))).rejects.toThrow();

    await files.remove(directory);
    await files.remove(directory);
    expect(await files.kind(directory)).toBeNull();
  });

  it('the command runner: status and both streams, and -1 for a tool that is not there', async () => {
    const run = systemCommandRunner(10_000);
    await expect(run('/bin/sh', ['-c', 'printf out; printf err >&2; exit 3'])).resolves.toEqual({
      status: 3,
      stdout: 'out',
      stderr: 'err',
    });
    await expect(run('/bin/sh', ['-c', 'printf "%s" "$PATH"'])).resolves.toMatchObject({
      status: 0,
      stdout: '/usr/bin:/bin:/usr/sbin:/sbin',
    });
    await expect(run(join(root, 'no-such-tool'), [])).resolves.toMatchObject({ status: -1 });
  });

  it('the whole swap on a real filesystem, and the previous bundle gone after the next start', async () => {
    const applications = join(root, 'Applications');
    const running = join(applications, 'Callie.app');
    const exe = join(running, 'Contents', 'MacOS', 'Callie');
    const updates = join(root, 'userData', 'updates');
    const store = realBundleStore();
    store.placeBundle(running, { version: '1.0.5', team: TEAM });
    const zip = fakeZip({ version: '1.0.6', team: TEAM });
    const manifest = manifestFor(zip, '1.0.6');

    const relaunched: string[] = [];
    const updaterAt = (currentVersion: string, decision: UpdateDecision): ReturnType<typeof createUpdater> =>
      createUpdater({
        currentVersion,
        systemVersion: '15.4.1',
        channelBaseUrl: CHANNEL,
        publicKey: 'compiled-in',
        host: { updateDirectory: updates, executablePath: exe, files: nodeUpdateFiles(), run: createFakeTools(store).run, now: () => new Date() },
        check: async () => await Promise.resolve(decision),
        download: async value => await downloadVerifiedArtifact(value, async () => await Promise.resolve(zip)),
        blocked: async () => await Promise.resolve(false),
        tell: async () => { await Promise.resolve(); },
        reveal: () => undefined,
        downloadDirectory: () => join(root, 'Downloads'),
        relaunch: path => { relaunched.push(path); },
        publish: () => undefined,
      });

    await expect(updaterAt('1.0.5', { kind: 'available', manifest }).atLaunch()).resolves.toEqual({
      kind: 'relaunching',
      version: '1.0.6',
    });
    expect(relaunched).toEqual([exe]);
    expect(store.bundleAt(running)?.version).toBe('1.0.6');
    expect(store.bundleAt(join(applications, '.Callie-1.0.5.previous'))?.version).toBe('1.0.5');
    expect((await readdir(applications)).sort()).toEqual(['.Callie-1.0.5.previous', 'Callie.app']);

    await updaterAt('1.0.6', { kind: 'up_to_date' }).atLaunch();
    expect(await readdir(applications)).toEqual(['Callie.app']);
    expect((await readdir(updates)).sort()).toEqual(['launched.json']);
  });
});
