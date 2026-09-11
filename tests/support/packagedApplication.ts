import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

/** Runner-only override: test a candidate without replacing the user's running app. */
export const packagedApplicationBinary = resolve(
  process.env.CALLIE_E2E_OUT_DIR || resolve(process.cwd(), 'out'),
  'Callie Founder Sales System-darwin-arm64',
  'Callie Founder Sales System.app',
  'Contents',
  'MacOS',
  'Callie Founder Sales System',
);

type ExitStatus = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type PackagedProcessEntry = {
  pid: number;
  parentPid: number;
  startedAt: string;
  command: string;
};

type ProcessCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<string>;

const runProcessCommand: ProcessCommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        env: {
          LANG: 'C',
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        },
        maxBuffer: 65_536,
        timeout: 2_000,
      },
      (error, stdout) => {
        if (error !== null) {
          const exitCode = 'code' in error ? error.code : undefined;
          if (
            (command === '/usr/bin/pgrep' || command === '/bin/ps')
            && exitCode === 1
          ) {
            resolve('');
            return;
          }
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });

const requirePid = (pid: number, description: string): void => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`${description} must be a positive integer PID.`);
  }
};

const parseChildPids = (output: string): number[] => {
  if (output.trim().length === 0) return [];
  const pids = output.trim().split(/\s+/u).map((value) => Number(value));
  if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error('Packaged process-tree inspection returned an invalid child PID.');
  }
  return [...new Set(pids)];
};

const parseProcessEntry = (
  pid: number,
  output: string,
): PackagedProcessEntry | undefined => {
  const match = output.trim().match(/^(\d+)\s+(.{24})\s+(.+)$/u);
  if (match === null) return undefined;
  const parentPid = Number(match[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('Packaged process-tree inspection returned an invalid parent PID.');
  }
  return { pid, parentPid, startedAt: match[2], command: match[3] };
};

export const snapshotPackagedProcessTree = async (
  rootPid: number,
  { runCommand = runProcessCommand }: { runCommand?: ProcessCommandRunner } = {},
): Promise<PackagedProcessEntry[]> => {
  requirePid(rootPid, 'Packaged application root');
  const entries: PackagedProcessEntry[] = [];
  const pendingParents = [rootPid];
  const visited = new Set<number>([rootPid]);

  while (pendingParents.length > 0) {
    const parentPid = pendingParents.shift();
    if (parentPid === undefined) break;
    const childPids = parseChildPids(
      await runCommand('/usr/bin/pgrep', ['-P', String(parentPid)]),
    );
    for (const childPid of childPids) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      const entry = parseProcessEntry(
        childPid,
        await runCommand('/bin/ps', [
          '-p',
          String(childPid),
          '-o',
          'ppid=',
          '-o',
          'lstart=',
          '-o',
          'command=',
        ]),
      );
      if (entry === undefined || entry.parentPid !== parentPid) continue;
      entries.push(entry);
      pendingParents.push(childPid);
    }
  }

  return entries;
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const waitForPackagedChildProcess = async (
  rootPid: number,
  predicate: (entry: PackagedProcessEntry) => boolean,
  {
    timeoutMs = 5_000,
    pollIntervalMs = 100,
    snapshotProcessTree = snapshotPackagedProcessTree,
  }: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    snapshotProcessTree?: (rootPid: number) => Promise<PackagedProcessEntry[]>;
  } = {},
): Promise<PackagedProcessEntry> => {
  requirePid(rootPid, 'Packaged application root');
  const deadline = Date.now() + timeoutMs;
  do {
    const found = (await snapshotProcessTree(rootPid)).find(predicate);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) break;
    await wait(pollIntervalMs);
  } while (Date.now() <= deadline);

  throw new Error('Timed out waiting for a packaged application child process.');
};

const inspectTrackedProcess = async (
  tracked: PackagedProcessEntry,
): Promise<PackagedProcessEntry | undefined> => {
  const current = parseProcessEntry(
    tracked.pid,
    await runProcessCommand('/bin/ps', [
      '-p',
      String(tracked.pid),
      '-o',
      'ppid=',
      '-o',
      'lstart=',
      '-o',
      'command=',
    ]),
  );
  return current;
};

const isSameProcessInstance = (
  tracked: PackagedProcessEntry,
  current: PackagedProcessEntry | undefined,
): current is PackagedProcessEntry => current !== undefined
  && current.pid === tracked.pid
  && current.command === tracked.command
  && current.startedAt === tracked.startedAt;

export const assertPackagedDescendantsExit = async (
  trackedDescendants: readonly PackagedProcessEntry[],
  {
    timeoutMs = 5_000,
    forceCleanupTimeoutMs = 1_000,
    pollIntervalMs = 100,
    inspectTrackedProcess: inspect = inspectTrackedProcess,
    signalProcess = (pid: number, signal: NodeJS.Signals): void => {
      process.kill(pid, signal);
    },
  }: {
    timeoutMs?: number;
    forceCleanupTimeoutMs?: number;
    pollIntervalMs?: number;
    inspectTrackedProcess?: (
      tracked: PackagedProcessEntry,
    ) => Promise<PackagedProcessEntry | undefined>;
    signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<void> => {
  for (const entry of trackedDescendants) {
    requirePid(entry.pid, 'Tracked descendant');
  }
  const remaining = new Map(
    trackedDescendants.map((entry) => [entry.pid, entry]),
  );
  const inspectInstance = async (
    tracked: PackagedProcessEntry,
  ): Promise<PackagedProcessEntry | undefined> => {
    const current = await inspect(tracked);
    return isSameProcessInstance(tracked, current) ? current : undefined;
  };
  const deadline = Date.now() + timeoutMs;

  do {
    for (const [pid, tracked] of remaining) {
      if (await inspectInstance(tracked) === undefined) remaining.delete(pid);
    }
    if (remaining.size === 0) return;
    if (Date.now() >= deadline) break;
    await wait(pollIntervalMs);
  } while (Date.now() <= deadline);

  const forceCleaned: PackagedProcessEntry[] = [];
  for (const [pid, tracked] of remaining) {
    if (await inspectInstance(tracked) === undefined) {
      remaining.delete(pid);
      continue;
    }
    try {
      signalProcess(tracked.pid, 'SIGKILL');
      forceCleaned.push(tracked);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw error;
      }
      remaining.delete(pid);
    }
  }
  if (remaining.size === 0) return;
  const cleanupDeadline = Date.now() + forceCleanupTimeoutMs;
  const forceCleanupRemaining = new Map(
    forceCleaned.map((entry) => [entry.pid, entry]),
  );
  do {
    for (const [pid, tracked] of forceCleanupRemaining) {
      if (await inspectInstance(tracked) === undefined) {
        forceCleanupRemaining.delete(pid);
      }
    }
    if (forceCleanupRemaining.size === 0) break;
    if (Date.now() >= cleanupDeadline) break;
    await wait(pollIntervalMs);
  } while (Date.now() <= cleanupDeadline);

  if (forceCleanupRemaining.size > 0) {
    throw new Error('A packaged application descendant could not be force-cleaned safely.');
  }
  throw new Error('A packaged application descendant did not exit with the packaged application.');
};

export type SpawnedApplication = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  removeListener(
    event: 'error' | 'exit',
    listener: (...args: unknown[]) => void,
  ): unknown;
};

const exitStatus = (application: SpawnedApplication): ExitStatus | undefined => {
  if (application.exitCode === null && application.signalCode === null) {
    return undefined;
  }

  return { code: application.exitCode, signal: application.signalCode };
};

const waitForExit = (
  application: SpawnedApplication,
  timeoutMs: number,
): Promise<ExitStatus | undefined> =>
  new Promise((resolve, reject) => {
    const existingExit = exitStatus(application);
    if (existingExit !== undefined) {
      resolve(existingExit);
      return;
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      application.removeListener(
        'exit',
        onExit as unknown as (...args: unknown[]) => void,
      );
      application.removeListener(
        'error',
        onError as unknown as (...args: unknown[]) => void,
      );
    };

    application.once('exit', onExit);
    application.once('error', onError);
  });

const signalAndWait = async (
  application: SpawnedApplication,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<ExitStatus | undefined> => {
  const waitingForExit = waitForExit(application, timeoutMs);

  if (!application.kill(signal)) {
    const exited = exitStatus(application);
    if (exited !== undefined) {
      return exited;
    }

    throw new Error(`Could not send ${signal} to the packaged application.`);
  }

  return waitingForExit;
};

export const terminatePackagedApplication = async (
  application: SpawnedApplication,
  timeoutMs = 5_000,
): Promise<ExitStatus> => {
  const existingExit = exitStatus(application);
  if (existingExit !== undefined) {
    return existingExit;
  }

  const gracefulExit = await signalAndWait(application, 'SIGTERM', timeoutMs);
  if (gracefulExit !== undefined) {
    return gracefulExit;
  }

  const forcedExit = await signalAndWait(application, 'SIGKILL', timeoutMs);
  if (forcedExit !== undefined) {
    return forcedExit;
  }

  throw new Error('Packaged application did not exit after SIGKILL.');
};

export const describeProcessExit = (application: SpawnedApplication): string =>
  `code=${application.exitCode ?? 'none'}, signal=${application.signalCode ?? 'none'}`;
