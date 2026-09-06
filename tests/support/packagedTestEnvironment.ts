import type { ChildProcess } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { terminatePackagedApplication } from './packagedApplication';

export type PackagedTestEnvironment = {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  capture(application: ChildProcess): ChildProcess;
  /** Stops only the captured child, then removes only this launch's owned root. */
  cleanup(): Promise<void>;
};

const fixtureOverrides = new Set([
  'CALLIE_SOURCING_FIXTURE_DIR',
  'CALLIE_SOURCING_FIXTURE_HANG_ONCE',
]);

const validateOverrides = async (overrides: Record<string, string>) => {
  const validated: Record<string, string> = Object.create(null);
  for (const key of Reflect.ownKeys(overrides)) {
    if (typeof key !== 'string' || !fixtureOverrides.has(key)) {
      throw new Error('Unknown packaged test environment override.');
    }
    const value = overrides[key];
    if (typeof value !== 'string' || value.length === 0
      || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new Error('Invalid packaged test environment override value.');
    }
    validated[key] = value;
  }
  if (validated.CALLIE_SOURCING_FIXTURE_HANG_ONCE !== undefined
    && validated.CALLIE_SOURCING_FIXTURE_HANG_ONCE !== '1') {
    throw new Error('Invalid packaged fixture hang-once override.');
  }
  const directory = validated.CALLIE_SOURCING_FIXTURE_DIR;
  if (directory !== undefined) {
    // Existing sourcing specs own mkdtemp inboxes directly beneath tmpdir().
    // Never resolve an arbitrary home/provider path or follow a fixture symlink.
    if (!isAbsolute(directory) || !/^callie-sourcing-(?:hung-)?fixture-[a-zA-Z0-9]+$/u.test(basename(directory))) {
      throw new Error('Expected an existing temporary sourcing fixture directory.');
    }
    const parent = await realpath(tmpdir());
    if (await realpath(dirname(directory)) !== parent) {
      throw new Error('Sourcing fixture directory must be inside the test temp directory.');
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || (process.getuid !== undefined && info.uid !== process.getuid())) {
      throw new Error('Sourcing fixture directory must be a caller-owned directory, not a symlink.');
    }
    validated.CALLIE_SOURCING_FIXTURE_DIR = await realpath(directory);
  }
  return validated;
};

/**
 * Normal GUI fixture children only. Never use for the sealed pre-release host,
 * backup:pre-release, or live Apple test-user acceptance. The runner HOME is not
 * changed. This isolates credential fallbacks, not arbitrary filesystem/egress.
 * Executable, flags, profiles and CDP remain owned by the existing call sites.
 */
export async function createPackagedTestEnvironment(
  overrides: Record<string, string> = {},
): Promise<PackagedTestEnvironment> {
  const validated = await validateOverrides(overrides);
  let root = await mkdtemp(join(tmpdir(), 'callie-packaged-env-'));
  const remove = () => rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  let env: NodeJS.ProcessEnv;
  try {
    root = await realpath(root);
    const home = join(root, 'home');
    const temp = join(root, 'tmp');
    const aws = join(root, 'aws');
    const inbox = join(root, 'inbox');
    // Sequential setup ensures a failed mkdir cannot race cleanup/recreate roots.
    for (const directory of [home, temp, aws, inbox]) await mkdir(directory, { mode: 0o700 });
    const config = join(aws, 'config');
    const credentials = join(aws, 'credentials');
    await writeFile(config, '', { mode: 0o600, flag: 'wx' });
    await writeFile(credentials, '', { mode: 0o600, flag: 'wx' });
    env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
      HOME: home,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      AWS_CONFIG_FILE: config,
      AWS_SHARED_CREDENTIALS_FILE: credentials,
      AWS_EC2_METADATA_DISABLED: 'true',
      CALLIE_SOURCING_FIXTURE_DIR: inbox,
      ...validated,
    };
    for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
      const value = process.env[key];
      if (value !== undefined && /^[a-zA-Z0-9_.@-]{1,80}$/u.test(value)) env[key] = value;
    }
  } catch (error) {
    await remove();
    throw error;
  }

  let application: ChildProcess | undefined;
  let exited = false;
  let captureClosed = false;
  let removal: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  let exitObserved: Promise<void> | undefined;
  const removeOnce = (): Promise<void> => {
    removal ??= remove().catch((error) => { removal = undefined; throw error; });
    return removal;
  };
  return {
    env: Object.freeze(env),
    capture(child) {
      if (captureClosed || application !== undefined) {
        throw new Error('A packaged test environment can capture only one child.');
      }
      application = child;
      exitObserved = new Promise<void>((resolve) => {
        // Spawn errors do not prove process exit. A no-PID spawn must close.
        const onError = (): void => undefined;
        const onExit = (): void => {
          exited = true;
          child.removeListener('exit', onExit);
          child.removeListener('close', onExit);
          child.removeListener('error', onError);
          resolve();
          // Retain instance-specific cleanup even if bounded termination fails.
          void removeOnce().catch((): undefined => undefined);
        };
        child.once('error', onError);
        child.once('exit', onExit);
        child.once('close', onExit);
        if (child.pid !== undefined && (child.exitCode !== null || child.signalCode !== null)) onExit();
      });
      return child;
    },
    cleanup() {
      captureClosed = true;
      cleaning ??= (async () => {
        if (application !== undefined && !exited) {
          // Preserve existing SIGTERM/SIGKILL bounds. This is not graceful-Quit proof.
          if (application.pid !== undefined) await terminatePackagedApplication(application);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              exitObserved,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Timed out waiting for captured packaged child exit.')), 5_000);
              }),
            ]);
          } finally { clearTimeout(timer); }
        }
        await removeOnce();
      })().catch((error) => { cleaning = undefined; throw error; });
      return cleaning;
    },
  };
}
