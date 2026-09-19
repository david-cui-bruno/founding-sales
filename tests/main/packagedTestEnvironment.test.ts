import { finished } from 'node:stream/promises';
import { EventEmitter } from 'node:events';
import { execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createPackage, uncacheAll } from '@electron/asar';
import { readArtifactIdentity, resolveReleaseArtifact } from '../../scripts/releaseArtifact.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackagedProcessEntry } from '../support/packagedApplication';
let packagedProcess: typeof import('../support/packagedApplication');
import type { FounderWorkspace, launchFounderWorkspace } from '../support/founderWorkspace';

// Execute the actual harness source with fake OS/process/CDP boundaries. Never
// import Playwright, launch Electron, open a socket, or inspect the runner HOME.
const checkout = process.cwd();
const inheritedOverrides = [
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT', 'AWS_SDK_LOAD_CONFIG', 'AWS_ENDPOINT_URL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy',
  'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_EXTRA_LAUNCH_ARGS',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'CALLIE_SOURCING_FIXTURE_DIR', 'CALLIE_SOURCING_FIXTURE_HANG_ONCE',
  'CALLIE_UNKNOWN_OVERRIDE', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'UNCONTROLLED_PARENT_VALUE',
  'CALLIE_RELEASE_OUT_DIR', 'CALLIE_E2E_OUT_DIR', 'CALLIE_E2E_EXPECTED_ARTIFACT',
];

class FakeChild extends EventEmitter {
  pid: number | undefined = 4200;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  closed = false;
  signals: NodeJS.Signals[] = [];
  beforeExit = (): void => undefined;

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.beforeExit();
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.closed = true;
    this.emit('close', code, signal);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }
}

type Launch = { child: FakeChild; binary: string; args: string[]; env: NodeJS.ProcessEnv };
let temporaryRoot: string;
let otherBinary: string;

beforeEach(async () => {
  temporaryRoot = await files.realpath(await files.mkdtemp(path.join(tmpdir(), 'callie-isolation-unit-')));
  await files.mkdir(path.join(temporaryRoot, 'parent-home'), { mode: 0o700 });
  // Own tiny real archives instead of reading an unbuilt candidate or canonical
  // package. Only process/CDP boundaries are faked, never artifact identity.
  const selectedOut = process.env.CALLIE_E2E_OUT_DIR || process.env.CALLIE_RELEASE_OUT_DIR
    ? 'candidate' : 'out';
  const artifacts = [];
  for (const [name, commit] of [[selectedOut, 'a'], ['other', 'b']]) {
    const artifact = resolveReleaseArtifact({ root: temporaryRoot, env: { CALLIE_RELEASE_OUT_DIR: name } });
    const input = path.join(temporaryRoot, `${name}-input`);
    await files.mkdir(input);
    await files.writeFile(path.join(input, 'release-marker.json'), JSON.stringify({
      format: 'callie-release', version: 1, commitSha: commit.repeat(40), builtAt: '2026-09-09T00:00:00.000Z',
    }));
    await files.mkdir(path.dirname(artifact.asarPath), { recursive: true });
    await files.mkdir(path.dirname(artifact.executable), { recursive: true });
    await files.writeFile(artifact.executable, 'synthetic-only', { mode: 0o700 });
    await finished(await createPackage(input, artifact.asarPath));
    artifacts.push(artifact);
  }
  const [selected, other] = artifacts;
  otherBinary = other.executable;
  vi.stubEnv('CALLIE_E2E_OUT_DIR', selected.outDirectory);
  vi.stubEnv('CALLIE_RELEASE_OUT_DIR', selected.outDirectory);
  vi.stubEnv('CALLIE_E2E_EXPECTED_ARTIFACT', JSON.stringify(readArtifactIdentity(selected.appPath)));
  vi.resetModules();
  packagedProcess = await import('../support/packagedApplication');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  uncacheAll();
  await files.rm(temporaryRoot, { recursive: true, force: true });
});

type Fault = 'spawn-throw' | 'spawn-error' | 'cdp-exit' | 'no-page' | 'browser-close' | 'port' | 'mkdir'
  | 'native-helper-error' | 'native-helper-invalid';
type Environment = {
  env: NodeJS.ProcessEnv;
  capture(child: FakeChild): FakeChild;
  cleanup(): Promise<void>;
};
type LaunchKind = 'shared' | 'foundation' | 'collision';

function sourceHarness(fault?: Fault, selectedBinary?: string) {
  const parentEnv: NodeJS.ProcessEnv = Object.fromEntries(
    inheritedOverrides.map((key) => [key, 'synthetic-only-do-not-log']),
  );
  Object.assign(parentEnv, {
    HOME: path.join(temporaryRoot, 'parent-home'),
    TMPDIR: temporaryRoot,
    PATH: '/synthetic/untrusted/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    LC_CTYPE: 'UTF-8',
  });
  const launches: Launch[] = [];
  const allocated: string[] = [];
  const removed: string[] = [];
  const delays: number[] = [];
  const events: string[] = [];
  const nativeReceipts: unknown[] = [];
  let spawnAttempts = 0;
  let kind: LaunchKind = 'shared';
  const registeredTests: Array<() => Promise<void>> = [];
  const locator = { click: async (): Promise<void> => undefined };
  const page = {
    url: () => 'callie://app/index.html',
    getByRole: () => locator,
    getByText: () => locator,
    locator: () => locator,
    on: (): void => undefined,
    evaluate: async () => ({ databasePath: '/synthetic/callie.sqlite3', schemaVersion: 17,
      databaseEncrypted: true, cipherVersion: 'fixture', fts5Available: true }),
  };
  const browser = {
    contexts: () => {
      events.push('renderer');
      return [{ pages: () => fault === 'no-page' || kind === 'collision' ? [] : [page] }];
    },
    close: async () => {
      events.push('browser-close');
      if (fault === 'browser-close') throw new Error('fixture close failure');
    },
  };
  // Renderer assertions are outside this source-only lifecycle test. Keep actual
  // callback/control flow, but replace UI-only matchers, not lifecycle code.
  const uiExpect = Object.assign((value: unknown) => Object.assign(expect(value), {
    toBeVisible: async (): Promise<void> => undefined,
    toHaveAttribute: async (): Promise<void> => undefined,
    toHaveURL: async (): Promise<void> => undefined,
    toBeDisabled: async (): Promise<void> => undefined,
    toHaveCount: async (): Promise<void> => undefined,
  }), { any: expect.any, poll: (read: () => Promise<unknown>) => ({
    toEqual: async (value: unknown) => expect(await read()).toEqual(value),
  }) });
  const modules = new Map<string, unknown>();
  const boundaries: Record<string, unknown> = {
    'node:fs': { ...fs, existsSync: () => true },
    'node:fs/promises': {
      ...files,
      mkdtemp: async (prefix: string) => {
        const directory = await files.mkdtemp(prefix);
        allocated.push(directory);
        return directory;
      },
      mkdir: async (...args: Parameters<typeof files.mkdir>) => {
        if (fault === 'mkdir') throw new Error('fixture mkdir failure');
        return files.mkdir(...args);
      },
      rm: async (target: string, options: Parameters<typeof files.rm>[1]) => {
        for (const { env, child } of launches) {
          if (env.HOME !== parentEnv.HOME && target === path.dirname(env.HOME ?? '')) {
            expect(child.closed || child.exitCode !== null || child.signalCode !== null).toBe(true);
          }
        }
        removed.push(target);
        return files.rm(target, options);
      },
    },
    'node:path': path,
    'node:os': { tmpdir: () => temporaryRoot },
    'node:net': {
      createServer: () => ({
        once: (event: string, listener: (error: Error) => void) => {
          if (fault === 'port' && event === 'error') queueMicrotask(() => listener(new Error('fixture port failure')));
        },
        listen: (_port: number, host: string, ready: () => void) => {
          expect(host).toBe('127.0.0.1');
          if (fault !== 'port') queueMicrotask(ready);
        },
        address: () => ({ port: 43123 }),
        close: (done?: () => void) => done?.(),
      }),
    },
    'node:child_process': {
      spawn: (binary: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        spawnAttempts += 1;
        if (fault === 'spawn-throw') throw new Error('fixture spawn failure');
        const child = new FakeChild();
        const env = options?.env ?? parentEnv;
        launches.push({ child, binary, args, env });
        events.push('spawn');
        queueMicrotask(() => events.push('spawn-microtask'));
        child.beforeExit = () => expect(fs.existsSync(env.HOME ?? '')).toBe(true);
        if (fault === 'spawn-error') {
          child.pid = undefined;
          queueMicrotask(() => {
            child.exitCode = -2;
            child.emit('error', new Error('fixture spawn error'));
            child.closed = true;
            child.emit('close', -2, null);
          });
        }
        return child;
      },
      // Synthetic OS boundary only. Never execute Swift, AX or another process.
      // The real helper source and native action have separate packaged proof.
      execFile: (binary: string, args: string[], options: unknown,
        callback: (error: Error | null, stdout: string) => void) => {
        const launch = launches.at(-1);
        expect(kind).toBe('collision');
        expect(launch).toBeDefined();
        const { child, binary: applicationBinary } = launch!;
        expect(binary).toBe('/usr/bin/swift');
        expect(args).toHaveLength(4);
        expect(args[0]).toBe(path.join(checkout, 'tests/support/nativeStartupDialog.swift'));
        expect(args[1]).toBe(String(child.pid));
        expect(args[2]).toBe(fs.realpathSync(applicationBinary));
        expect(Number.isFinite(Number(args[3]))).toBe(true);
        expect(child.closed).toBe(false);
        expect(options).toEqual({ encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 8192 });
        events.push('native-helper');
        const start = Math.round(Number(args[3]) * 1_000_000);
        queueMicrotask(() => {
          if (fault === 'native-helper-error') {
            callback(new Error('synthetic native helper failure'), '');
            return;
          }
          callback(null, JSON.stringify({
            formatVersion: 1, pid: fault === 'native-helper-invalid' ? 9999 : child.pid,
            executable: args[2],
            processStart: { seconds: Math.floor(start / 1_000_000), microseconds: start % 1_000_000 },
            observed: true, pressed: true,
            message: 'Callie startup did not complete.',
            detail: 'APPLICATION_STARTUP_FAILED\nQuit Callie to close this attempt. If Restart Callie is offered, you can try starting it again.',
            buttons: ['Quit', 'Restart Callie'],
          }));
          if (fault !== 'native-helper-invalid') queueMicrotask(() => child.exit());
        });
      },
    },
    'playwright/test': {
      chromium: { connectOverCDP: async (url: string) => {
        events.push('cdp');
        expect(url).toBe('http://127.0.0.1:43123');
        if (fault === 'spawn-error') throw new Error('fixture debugger unavailable');
        if (fault === 'cdp-exit') {
          launches.at(-1)?.child.exit(7);
          throw new Error('fixture CDP failure');
        }
        return browser;
      } },
      expect: uiExpect,
      test: Object.assign((_name: string, body: () => Promise<void>) => registeredTests.push(body), {
        info: () => ({ attach: async (name: string, attachment: { body: string; contentType: string }) => {
          expect(name).toBe('owned-native-startup-quit');
          expect(attachment.contentType).toBe('application/json');
          nativeReceipts.push(JSON.parse(attachment.body));
        } }),
      }),
    },
  };
  function load(relativePath: string): Record<string, unknown> {
    const filename = path.resolve(checkout, relativePath);
    if (modules.has(filename)) return modules.get(filename) as Record<string, unknown>;
    // Expose existing private foundation functions only in this in-memory test.
    const source = fs.readFileSync(filename, 'utf8') + (filename.endsWith('/foundation.spec.ts')
      ? '\nexport { inspectPackagedApplication, inspectFailedPackagedLaunch };' : '');
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: filename,
    }).outputText;
    const exports: Record<string, unknown> = {};
    modules.set(filename, exports);
    runInNewContext(output, {
      exports,
      __dirname: path.dirname(filename),
      AbortController,
      // Host expect.any(Number) must receive the same primitive constructor.
      Number,
      require: (specifier: string) => {
        if (specifier in boundaries) return boundaries[specifier];
        if (specifier.endsWith('/packagedApplication')) return {
          ...packagedProcess,
          packagedApplicationBinary: selectedBinary ?? packagedProcess.packagedApplicationBinary,
          // Real bounded termination, only its wait duration is shortened.
          terminatePackagedApplication: (child: FakeChild) => packagedProcess.terminatePackagedApplication(child, 5),
          waitForPackagedChildProcess: async () => ({ pid: 4201, parentPid: 4200, startedAt: 'fixture', command: 'CallieAppleBridge' }),
          snapshotPackagedProcessTree: async (): Promise<PackagedProcessEntry[]> => [],
          assertPackagedDescendantsExit: async () => {
            expect(launches.at(-1)?.child.closed).toBe(true);
          },
        };
        if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), `${specifier}.ts`));
        throw new Error(`Unapproved source-test import: ${specifier}`);
      },
      process: { env: parentEnv, cwd: () => checkout, getuid: process.getuid, platform: 'darwin' },
      setTimeout: (callback: () => void, milliseconds: number) => {
        delays.push(milliseconds);
        // The collision exit deadline now spans an awaited realpath before the
        // fake OS callback. Keep it finite without a 2ms filesystem race.
        return setTimeout(callback, kind === 'collision' && milliseconds === 20_000
          ? 1_000 : Math.min(milliseconds, 2));
      },
      clearTimeout, queueMicrotask, Error,
    }, { filename });
    return exports;
  }
  const launchShared = async (options: Parameters<typeof launchFounderWorkspace>[0] = {}): Promise<FounderWorkspace> => {
    const module = load('tests/support/founderWorkspace.ts');
    return (module.launchFounderWorkspace as (options: object) => Promise<FounderWorkspace>)(options);
  };
  const run = async (launchKind: LaunchKind): Promise<void> => {
    kind = launchKind;
    if (kind === 'shared') {
      const workspace = await launchShared();
      await workspace.close();
    } else {
      const module = load('tests/e2e/foundation.spec.ts');
      const inspect = module[kind === 'foundation' ? 'inspectPackagedApplication' : 'inspectFailedPackagedLaunch'];
      await (inspect as (profile: string) => Promise<unknown>)(path.join(temporaryRoot, 'caller-profile'));
    }
  };
  const createEnvironment = async (overrides: Record<string, string> = {}): Promise<Environment> => {
    const module = load('tests/support/packagedTestEnvironment.ts');
    return (module.createPackagedTestEnvironment as (overrides: object) => Promise<Environment>)(overrides);
  };
  return { parentEnv, launches, launchShared, run, createEnvironment, allocated, removed, delays, events, nativeReceipts,
    spawnAttempts: () => spawnAttempts };
}

describe('normal packaged GUI child credential isolation', () => {
  it('shared launch discards inherited credentials and uncontrolled overrides', async () => {
    const harness = sourceHarness();
    const workspace = await harness.launchShared();
    try {
      const env = harness.launches[0].env;
      // Assert names/booleans only, never display sentinel or real secret values.
      const forbidden = inheritedOverrides.filter((key) => ![
        'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'CALLIE_SOURCING_FIXTURE_DIR',
      ].includes(key));
      expect(forbidden.filter((key) => env[key] !== undefined)).toEqual([]);
      expect(env.HOME === harness.parentEnv.HOME).toBe(false);
      expect(harness.launches).toHaveLength(1);
    } finally {
      await workspace.close();
    }
  });
});

const launchKinds: LaunchKind[] = ['shared', 'foundation', 'collision'];

describe('shared captured-child observation seam', () => {
  it('invokes onSpawn once with the captured instance synchronously before CDP and renderer discovery', async () => {
    const harness = sourceHarness();
    const observed: ChildProcess[] = [];
    const workspace = await harness.launchShared({ onSpawn: (application) => {
      observed.push(application);
      harness.events.push('onSpawn');
    } });
    try {
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBe(harness.launches[0].child);
      expect(workspace.application).toBe(observed[0]);
      expect(harness.events).toEqual(['spawn', 'onSpawn', 'cdp', 'spawn-microtask', 'renderer']);
    } finally { await workspace.close(); }
  });

  it('returns the captured instance without a callback and keeps owned-profile stop/close semantics', async () => {
    const harness = sourceHarness();
    const workspace = await harness.launchShared();
    try {
      const { child, env } = harness.launches[0];
      expect(workspace.application).toBe(child);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      await workspace.stop();
      expect(child.closed).toBe(true);
      expect(child.signals).toEqual(['SIGTERM']);
      expect(fs.existsSync(env.HOME!)).toBe(false);
      expect(fs.existsSync(workspace.userDataPath)).toBe(true);
      await workspace.close();
      expect(child.signals).toEqual(['SIGTERM']);
      expect(fs.existsSync(workspace.userDataPath)).toBe(false);
      expect(harness.events.filter((event) => event === 'browser-close')).toHaveLength(2);
    } finally { await workspace.close(); }
  });

  it.each(['mkdir', 'port', 'spawn-throw'] as const)('does not invoke onSpawn on pre-capture failure (%s)', async (fault) => {
    const harness = sourceHarness(fault);
    const observed: ChildProcess[] = [];
    await expect(harness.launchShared({ onSpawn: (application) => { observed.push(application); } })).rejects.toThrow();
    expect(observed).toEqual([]);
    expect(harness.launches).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
  });

  it.each([false, true])('cleans callback failure before CDP without deleting caller ownership (caller profile: %s)', async (callerOwned) => {
    const harness = sourceHarness();
    const profile = callerOwned ? await files.mkdtemp(path.join(temporaryRoot, 'caller-profile-')) : undefined;
    if (profile !== undefined) await files.writeFile(path.join(profile, 'caller-owned.txt'), 'synthetic profile');
    const failure = new Error('fixture observer failure');
    const observed: ChildProcess[] = [];
    const launch = harness.launchShared({ userDataPath: profile, onSpawn: (application) => {
      observed.push(application);
      harness.events.push('onSpawn');
      throw failure;
    } });
    try {
      await expect(launch).rejects.toBe(failure);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBe(harness.launches[0].child);
      expect(harness.events).toEqual(['spawn', 'onSpawn', 'spawn-microtask']);
      expect(harness.launches[0].child.closed).toBe(true);
      expect(harness.launches[0].child.signals).toEqual(['SIGTERM']);
      expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
      if (profile !== undefined) {
        expect(await files.readFile(path.join(profile, 'caller-owned.txt'), 'utf8')).toBe('synthetic profile');
        expect(harness.removed).not.toContain(profile);
      }
    } finally { await launch.then((workspace) => workspace.close(), (): undefined => undefined); }
  });

  it('installs the owned spawn-error listener before invoking onSpawn', async () => {
    const harness = sourceHarness();
    const failure = new Error('fixture synchronous spawn error');
    const launch = harness.launchShared({ onSpawn: (application) => {
      harness.events.push('onSpawn');
      application.emit('error', failure);
    } });
    try {
      await expect(launch).rejects.toThrow('The packaged application failed to spawn: fixture synchronous spawn error');
      expect(harness.events).toEqual(['spawn', 'onSpawn', 'spawn-microtask']);
      expect(harness.launches[0].child.closed).toBe(true);
      expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
    } finally { await launch.then((workspace) => workspace.close(), (): undefined => undefined); }
  });
});

describe('every packaged source call site', () => {
  it('binds the synthetic native helper to the captured child and accepts no cleanup signal as Quit', async () => {
    const harness = sourceHarness();
    await harness.run('collision');
    expect(harness.events.filter((event) => event === 'native-helper')).toEqual(['native-helper']);
    expect(harness.nativeReceipts).toHaveLength(1);
    expect(harness.launches[0].child.signals).toEqual([]);
    expect(harness.launches[0].child.exitCode).toBe(0);
    expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
  });

  it.each(['native-helper-error', 'native-helper-invalid'] as const)('rejects %s and joins owned child/environment cleanup', async (fault) => {
    const harness = sourceHarness(fault);
    await expect(harness.run('collision')).rejects.toThrow();
    expect(harness.spawnAttempts()).toBe(1);
    expect(harness.events.filter((event) => event === 'native-helper')).toEqual(['native-helper']);
    expect(harness.nativeReceipts).toEqual([]);
    expect(harness.launches[0].child.signals).toEqual(['SIGTERM']);
    expect(harness.launches[0].child.closed).toBe(true);
    expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
    expect(fs.existsSync(harness.parentEnv.HOME ?? '')).toBe(true);
  });

  it.each(launchKinds)('%s rejects a different real artifact before spawn without leaking or retaining its environment', async (kind) => {
    const harness = sourceHarness(undefined, otherBinary);
    await expect(harness.run(kind)).rejects.toThrow('RELEASE_ARTIFACT_MISMATCH');
    expect(harness.spawnAttempts()).toBe(0);
    expect(harness.launches).toEqual([]);
    expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
    expect(fs.existsSync(harness.parentEnv.HOME ?? '')).toBe(true);
  });

  it.each(launchKinds)('%s uses the same isolated environment and removes it after captured exit', async (kind) => {
    const harness = sourceHarness();
    const parentBefore = { ...harness.parentEnv };
    await harness.run(kind);
    expect(harness.spawnAttempts()).toBe(1);
    const { child, env, binary, args } = harness.launches[0];
    expect(env.HOME === harness.parentEnv.HOME).toBe(false);
    expect(env.AWS_ACCESS_KEY_ID !== undefined).toBe(false);
    expect(env.CALLIE_SOURCING_FIXTURE_HANG_ONCE !== undefined).toBe(false);
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
    expect(binary).toBe(packagedProcess.packagedApplicationBinary);
    expect(args).toEqual([
      expect.stringMatching(/^--user-data-dir=/u), '--remote-debugging-port=43123', '--use-mock-keychain',
    ]);
    expect(child.closed).toBe(true);
    expect(fs.existsSync(env.HOME ?? '')).toBe(false);
    expect(harness.parentEnv).toEqual(parentBefore);
    expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
    expect(fs.existsSync(harness.parentEnv.HOME ?? '')).toBe(true);
  });

  for (const fault of ['spawn-throw', 'spawn-error', 'port', 'mkdir'] as const) {
    it.each(launchKinds)(`%s cleans setup/spawn failure (${fault}) without starting a second child`, async (kind) => {
      const harness = sourceHarness(fault);
      await expect(harness.run(kind)).rejects.toThrow();
      expect(harness.spawnAttempts()).toBeLessThanOrEqual(1);
      expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
      expect(fs.existsSync(harness.parentEnv.HOME ?? '')).toBe(true);
    });
  }

  for (const fault of ['cdp-exit', 'no-page', 'browser-close'] as const) {
    it.each(['shared', 'foundation'] as const)(`%s cleans CDP/teardown failure (${fault})`, async (kind) => {
      const harness = sourceHarness(fault);
      if (kind === 'shared' && fault === 'browser-close') await harness.run(kind);
      else await expect(harness.run(kind)).rejects.toThrow();
      expect(harness.spawnAttempts()).toBe(1);
      expect(harness.launches[0].child.closed).toBe(true);
      expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
    });
  }

  it('preserves caller fixture inbox, hang-once and userData across stop/close/relaunch', async () => {
    const harness = sourceHarness();
    const fixture = await files.mkdtemp(path.join(temporaryRoot, 'callie-sourcing-hung-fixture-'));
    const profile = await files.mkdtemp(path.join(temporaryRoot, 'caller-profile-'));
    const marker = path.join(fixture, 'caller-owned.txt');
    await files.writeFile(marker, 'synthetic fixture');
    const observed: ChildProcess[] = [];
    const options = { userDataPath: profile, env: {
      CALLIE_SOURCING_FIXTURE_DIR: fixture, CALLIE_SOURCING_FIXTURE_HANG_ONCE: '1',
    }, onSpawn: (application: ChildProcess) => { observed.push(application); } };
    const first = await harness.launchShared(options);
    expect(observed).toHaveLength(1);
    expect(first.application).toBe(observed[0]);
    expect(observed[0]).toBe(harness.launches[0].child);
    expect(harness.launches[0].env.CALLIE_SOURCING_FIXTURE_DIR).toBe(await files.realpath(fixture));
    expect(harness.launches[0].env.CALLIE_SOURCING_FIXTURE_HANG_ONCE).toBe('1');
    await first.stop();
    await first.close();
    const second = await harness.launchShared(options);
    expect(observed).toHaveLength(2);
    expect(second.application).toBe(observed[1]);
    expect(observed[1]).toBe(harness.launches[1].child);
    expect(second.application).not.toBe(first.application);
    expect(second.userDataPath).toBe(profile);
    expect(harness.launches[1].env.HOME === harness.launches[0].env.HOME).toBe(false);
    await second.close();
    expect(await files.readFile(marker, 'utf8')).toBe('synthetic fixture');
    expect(fs.existsSync(profile)).toBe(true);
    expect(harness.removed.includes(fixture) || harness.removed.includes(profile)).toBe(false);
  });

  it.each(['spawn-throw', 'spawn-error', 'cdp-exit', 'no-page'] as const)(
    'retains the explicit caller fixture/profile after shared failure (%s)', async (fault) => {
      const harness = sourceHarness(fault);
      const fixture = await files.mkdtemp(path.join(temporaryRoot, 'callie-sourcing-fixture-'));
      const profile = await files.mkdtemp(path.join(temporaryRoot, 'caller-profile-'));
      const marker = path.join(fixture, 'caller-owned.txt');
      await files.writeFile(marker, 'synthetic fixture');
      const observed: ChildProcess[] = [];
      const lifecycle: string[] = [];
      await expect(harness.launchShared({
        userDataPath: profile, env: { CALLIE_SOURCING_FIXTURE_DIR: fixture },
        onSpawn: (application) => {
          observed.push(application);
          application.once('error', () => lifecycle.push('error'));
          application.once('exit', () => lifecycle.push('exit'));
          application.once('close', () => lifecycle.push('close'));
        },
      })).rejects.toThrow();
      if (fault === 'spawn-throw') {
        expect(observed).toEqual([]);
        expect(lifecycle).toEqual([]);
      } else {
        expect(observed).toHaveLength(1);
        expect(observed[0]).toBe(harness.launches[0].child);
        expect(lifecycle).toEqual(fault === 'spawn-error' ? ['error', 'close'] : ['exit', 'close']);
      }
      expect(await files.readFile(marker, 'utf8')).toBe('synthetic fixture');
      expect(fs.existsSync(profile)).toBe(true);
      expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
      expect(harness.removed.includes(fixture) || harness.removed.includes(profile)).toBe(false);
    },
  );
});

describe('private test environment and lifetime', () => {
  it('creates canonical private empty home/temp/AWS/default inbox and preserves only deliberate locale values', async () => {
    const harness = sourceHarness();
    const environment = await harness.createEnvironment();
    const env = environment.env;
    const root = path.dirname(env.HOME!);
    try {
      expect(await files.realpath(root)).toBe(root);
      expect((await files.stat(root)).mode & 0o777).toBe(0o700);
      expect(Object.keys(env).sort()).toEqual([
        'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_SHARED_CREDENTIALS_FILE',
        'CALLIE_SOURCING_FIXTURE_DIR', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TEMP', 'TMP', 'TMPDIR',
      ].sort());
      expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
      expect(env.LANG).toBe('en_US.UTF-8');
      expect(env.LC_ALL).toBe('C');
      expect(env.LC_CTYPE).toBe('UTF-8');
      for (const key of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'CALLIE_SOURCING_FIXTURE_DIR']) {
        const directory = env[key]!;
        expect(directory.startsWith(`${root}${path.sep}`)).toBe(true);
        expect(await files.realpath(directory)).toBe(directory);
        expect((await files.stat(directory)).mode & 0o777).toBe(0o700);
        expect(await files.readdir(directory)).toEqual([]);
      }
      for (const key of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) {
        const filename = env[key]!;
        expect(filename.startsWith(`${root}${path.sep}`)).toBe(true);
        expect((await files.stat(filename)).mode & 0o777).toBe(0o600);
        expect(await files.readFile(filename, 'utf8')).toBe('');
      }
      // This is solely the synthetic home fallback, never the runner's home.
      expect(fs.existsSync(path.join(env.HOME!, '.callie-sourcing-app-inbox-key.json'))).toBe(false);
    } finally { await environment.cleanup(); }
    await environment.cleanup();
    expect(fs.existsSync(root)).toBe(false);
    expect(harness.removed.filter((entry) => entry === root)).toHaveLength(1);
  });

  it.each(['HOME', 'PATH', 'AWS_PROFILE', 'NODE_OPTIONS', 'CALLIE_UNKNOWN_OVERRIDE', 'CALLIE_APPLE_TEST_MODE', '__proto__'])(
    'rejects unknown caller override %s before allocating or spawning', async (key) => {
      const harness = sourceHarness();
      await expect(harness.launchShared({ env: Object.fromEntries([[key, 'synthetic']]) })).rejects.toThrow(/override/iu);
      expect(harness.spawnAttempts()).toBe(0);
      expect(harness.allocated.every((root) => !fs.existsSync(root))).toBe(true);
    },
  );

  it.each(['', 'relative/fixture', 'https://fixture.invalid/inbox', '/'])('rejects invalid fixture paths (%s)', async (directory) => {
    await expect(sourceHarness().createEnvironment({ CALLIE_SOURCING_FIXTURE_DIR: directory })).rejects.toThrow();
  });

  it('rejects non-directory/symlink fixtures, non-fixture home paths and invalid hang-once values', async () => {
    const fixture = await files.mkdtemp(path.join(temporaryRoot, 'callie-sourcing-fixture-'));
    const link = path.join(temporaryRoot, 'callie-sourcing-fixture-link');
    const file = path.join(temporaryRoot, 'callie-sourcing-fixture-file');
    await files.symlink(fixture, link);
    await files.writeFile(file, 'synthetic');
    for (const directory of [link, file, path.join(temporaryRoot, 'parent-home')]) {
      await expect(sourceHarness().createEnvironment({ CALLIE_SOURCING_FIXTURE_DIR: directory })).rejects.toThrow();
    }
    for (const value of ['', '0', 'true', '1\n']) {
      await expect(sourceHarness().createEnvironment({ CALLIE_SOURCING_FIXTURE_HANG_ONCE: value })).rejects.toThrow();
    }
  });

  it('drops malformed parent locale instead of using it as an uncontrolled override', async () => {
    const harness = sourceHarness();
    harness.parentEnv.LANG = '../../synthetic';
    harness.parentEnv.LC_ALL = 'C\nSYNTHETIC=1';
    const environment = await harness.createEnvironment();
    try {
      expect(environment.env.LANG).toBe('en_US.UTF-8');
      expect(environment.env.LC_ALL).toBeUndefined();
    } finally { await environment.cleanup(); }
  });

  it('a tiny Node fixture child resolves homedir/temp/fallback only beneath the synthetic root', async () => {
    const environment = await sourceHarness().createEnvironment();
    try {
      // Boolean-only Node probe. No app, filesystem reads, provider, or network.
      const output = execFileSync(process.execPath, ['-e', `
        const { homedir, tmpdir } = require('node:os');
        const { dirname, join, sep } = require('node:path');
        const root = dirname(process.env.HOME);
        console.log(homedir() === process.env.HOME && tmpdir() === process.env.TMPDIR
          && [homedir(), tmpdir(), process.env.AWS_CONFIG_FILE,
            process.env.AWS_SHARED_CREDENTIALS_FILE,
            join(homedir(), '.callie-sourcing-app-inbox-key.json')]
            .every(path => path.startsWith(root + sep)));
      `], { env: environment.env, encoding: 'utf8', timeout: 2_000 });
      expect(output.trim()).toBe('true');
    } finally { await environment.cleanup(); }
  });

  it('waits for captured child exit, is idempotent and cannot bind a second child', async () => {
    const harness = sourceHarness();
    const environment = await harness.createEnvironment();
    const child = new FakeChild();
    const root = path.dirname(environment.env.HOME!);
    environment.capture(child);
    expect(() => environment.capture(new FakeChild())).toThrow();
    child.beforeExit = () => expect(fs.existsSync(root)).toBe(true);
    await Promise.all([environment.cleanup(), environment.cleanup()]);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(fs.existsSync(root)).toBe(false);
    expect(harness.removed.filter((entry) => entry === root)).toHaveLength(1);
  });

  it('bounds a stubborn-child failure, retains its root while alive and cleans after eventual captured exit', async () => {
    const harness = sourceHarness();
    const environment = await harness.createEnvironment();
    const child = new FakeChild();
    child.kill = (signal) => { child.signals.push(signal); return true; };
    environment.capture(child);
    const root = path.dirname(environment.env.HOME!);
    await expect(environment.cleanup()).rejects.toThrow(/did not exit/iu);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(fs.existsSync(root)).toBe(true);
    child.exit();
    // The listener remains attached only to the captured instance after failure.
    await environment.cleanup();
    expect(fs.existsSync(root)).toBe(false);
  });

  it('does not confuse a failed spawn error with exit until its close event', async () => {
    const harness = sourceHarness();
    const environment = await harness.createEnvironment();
    const child = new FakeChild();
    child.pid = undefined;
    environment.capture(child);
    const root = path.dirname(environment.env.HOME!);
    child.emit('error', new Error('synthetic spawn failure'));
    await expect(environment.cleanup()).rejects.toThrow(/exit/iu);
    expect(fs.existsSync(root)).toBe(true);
    expect(harness.delays.every((delay) => delay > 0 && delay <= 10_000)).toBe(true);
    child.closed = true;
    child.emit('close', -2, null);
    await environment.cleanup();
    expect(fs.existsSync(root)).toBe(false);
  });
});
