import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, expect, test, type Browser } from 'playwright/test';
import {
  describeProcessExit,
  terminatePackagedApplication,
} from '../support/packagedApplication';

const packagedApplication = join(
  process.cwd(),
  'out',
  'Callie Founder Sales System-darwin-arm64',
  'Callie Founder Sales System.app',
  'Contents',
  'MacOS',
  'Callie Founder Sales System',
);

test('packaged diagnostics use callie protocol and an isolated native SQLite database', async () => {
  let userDataPath: string | undefined;

  try {
    expect(existsSync(packagedApplication)).toBe(true);
    userDataPath = await mkdtemp(join(tmpdir(), 'callie-foundation-e2e-'));
    const firstLaunch = await inspectPackagedApplication(userDataPath);
    const secondLaunch = await inspectPackagedApplication(userDataPath);
    const expectedDatabasePath = join(await realpath(userDataPath), 'callie.sqlite3');

    expect(firstLaunch).toEqual({
      databasePath: expectedDatabasePath,
      schemaVersion: 12,
      databaseEncrypted: true,
      cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
      fts5Available: true,
    });
    expect(secondLaunch).toEqual(firstLaunch);
    expect(existsSync(expectedDatabasePath)).toBe(true);

    expect((await readFile(expectedDatabasePath)).subarray(0, 16).toString('utf8'))
      .not.toBe('SQLite format 3\u0000');
  } finally {
    if (userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});

test('packaged startup leaves an isolated database collision untouched and recovers on relaunch', async () => {
  let userDataPath: string | undefined;

  try {
    userDataPath = await mkdtemp(join(tmpdir(), 'callie-foundation-retry-e2e-'));
    const databasePath = join(await realpath(userDataPath), 'callie.sqlite3');
    const collisionMarker = join(databasePath, 'owned-by-foundation-e2e.txt');
    await mkdir(databasePath, { mode: 0o700 });
    await writeFile(collisionMarker, 'isolated collision\n', { mode: 0o600 });

    const failedLaunch = await inspectFailedPackagedLaunch(userDataPath);

    expect(failedLaunch).toEqual({
      exitCode: 0,
      signalCode: null,
      rendererPageObserved: false,
    });
    expect((await stat(databasePath)).isDirectory()).toBe(true);
    expect(await readFile(collisionMarker, 'utf8')).toBe('isolated collision\n');
    expect(await readdir(databasePath)).toEqual(['owned-by-foundation-e2e.txt']);
    expect(existsSync(`${databasePath}-journal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);

    // The current eager-startup contract exits before creating a window. A later
    // founder-workflow task intentionally restores in-window Retry via lazy domain
    // initialization. Until then, recovery is a clean relaunch of the same path.
    await rm(databasePath, { recursive: true });
    const health = await inspectPackagedApplication(userDataPath);

    expect(health).toEqual({
      databasePath,
      schemaVersion: 12,
      databaseEncrypted: true,
      cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
      fts5Available: true,
    });
    expect((await stat(databasePath)).isFile()).toBe(true);

    expect((await readFile(databasePath)).subarray(0, 16).toString('utf8'))
      .not.toBe('SQLite format 3\u0000');
  } finally {
    if (userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});

const inspectPackagedApplication = async (userDataPath: string) => {
  const debuggingPort = await availablePort();
  let application: ChildProcess | undefined;
  let browser: Browser | undefined;
  let spawnError: Error | undefined;

  try {
    // The packaged binary intentionally disables RunAsNode. Playwright's
    // Electron launcher requires that mode, so CDP inspects the real packaged
    // process without weakening the production fuse.
    application = spawn(packagedApplication, [
      `--user-data-dir=${userDataPath}`,
      `--remote-debugging-port=${debuggingPort}`,
      '--use-mock-keychain',
    ]);
    application.once('error', (error) => {
      spawnError = error;
    });
    browser = await connectToPackagedApplication(
      application,
      debuggingPort,
      () => spawnError,
    );
    const page = browser.contexts()[0]?.pages()[0];

    if (page === undefined) {
      throw new Error('The packaged application did not create a renderer page.');
    }

    // A healthy foundation now boots the workflow shell on the Today route.
    await expect(
      page.getByRole('navigation', { name: 'Primary' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page).toHaveURL(/callie:\/\/app\/index\.html/);

    // Foundation diagnostics stay reachable behind the Settings route;
    // Diagnostics is the default selected section of the master-detail.
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByText('Encrypted SQLite ready')).toBeVisible();
    await expect(page.getByText('FTS5 available')).toBeVisible();
    await expect(page.getByText('Schema 12')).toBeVisible();
    // The sourcing status row renders regardless of credential state; the
    // packaged test env may report none, file, or keychain depending on the
    // machine, and auto-polling stays disabled under --use-mock-keychain.
    // It lives in the Sourcing section of the settings master-detail.
    await page.getByRole('button', { name: 'Sourcing', exact: true }).click();
    await expect(page.getByText(/^Sourcing inbox: /)).toBeVisible();

    const health = await page.evaluate(() => window.callie.health.get());
    return {
      databasePath: health.databasePath,
      schemaVersion: health.schemaVersion,
      databaseEncrypted: health.databaseEncrypted,
      cipherVersion: health.cipherVersion,
      fts5Available: health.fts5Available,
    };
  } finally {
    try {
      await browser?.close();
    } finally {
      if (application?.pid !== undefined) {
        await terminatePackagedApplication(application);
      }
    }
  }
};

const inspectFailedPackagedLaunch = async (userDataPath: string) => {
  const debuggingPort = await availablePort();
  let application: ChildProcess | undefined;

  try {
    application = spawn(packagedApplication, [
      `--user-data-dir=${userDataPath}`,
      `--remote-debugging-port=${debuggingPort}`,
      '--use-mock-keychain',
    ]);
    const [exit, rendererPageObserved] = await Promise.all([
      waitForPackagedExit(application),
      observeRendererPageUntilExit(application, debuggingPort),
    ]);

    return {
      exitCode: exit.code,
      signalCode: exit.signal,
      rendererPageObserved,
    };
  } finally {
    if (application?.pid !== undefined) {
      await terminatePackagedApplication(application);
    }
  }
};

const waitForPackagedExit = (
  application: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    if (application.exitCode !== null || application.signalCode !== null) {
      resolve({ code: application.exitCode, signal: application.signalCode });
      return;
    }

    const cleanup = (): void => {
      clearTimeout(timer);
      application.removeListener('error', handleError);
      application.removeListener('exit', handleExit);
    };
    const handleError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const handleExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for failed packaged startup to exit.'));
    }, timeoutMs);

    application.once('error', handleError);
    application.once('exit', handleExit);
  });

const observeRendererPageUntilExit = async (
  application: ChildProcess,
  debuggingPort: number,
): Promise<boolean> => {
  while (application.exitCode === null && application.signalCode === null) {
    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${debuggingPort}`,
        { timeout: 100 },
      );
      if (browser.contexts().some((context) => context.pages().length > 0)) {
        return true;
      }
    } catch {
      // The debugger may not be listening yet, or startup may already be exiting.
    } finally {
      await browser?.close().catch((): undefined => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return false;
};

const availablePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a debugging port.'));
        return;
      }

      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });

const connectToPackagedApplication = async (
  application: ChildProcess,
  debuggingPort: number,
  getSpawnError: () => Error | undefined,
): Promise<Browser> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const spawnError = getSpawnError();
    if (spawnError !== undefined) {
      throw new Error(`The packaged application failed to spawn: ${spawnError.message}`);
    }

    if (application.exitCode !== null || application.signalCode !== null) {
      throw new Error(
        `The packaged application exited before inspection (${describeProcessExit(application)}).`,
      );
    }

    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${debuggingPort}`,
      );
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    for (let pageAttempt = 0; pageAttempt < 80; pageAttempt += 1) {
      if (browser.contexts().some((context) => context.pages().length > 0)) {
        return browser;
      }
      if (application.exitCode !== null || application.signalCode !== null) {
        await browser.close();
        throw new Error(
          `The packaged application exited before creating a page (${describeProcessExit(application)}).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await browser.close();
    throw new Error('Timed out waiting for the packaged application page.');
  }

  throw new Error('Timed out waiting for the packaged application debugger.');
};
