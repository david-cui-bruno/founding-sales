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
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chromium, expect, test, type Browser, type Page } from 'playwright/test';
import { assertPackagedApplicationIdentity, describeProcessExit, packagedApplicationBinary as packagedApplication } from '../support/packagedApplication';
import { createPackagedTestEnvironment } from '../support/packagedTestEnvironment';

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
      schemaVersion: 24,
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

// CDP can drive the production renderer/preload but not macOS native dialogs.
// This is intentionally partial packaged coverage, not export/drill acceptance.
test('packaged recovery setup is explicit and persists only completion across isolated relaunch', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'callie-recovery-e2e-'));
  let setupCompletedAt: string | null = null;
  try {
    await inspectPackagedApplication(userDataPath, async (page) => {
      await page.getByRole('button', { name: 'Data & storage', exact: true }).click();
      await expect(page.getByText('Recovery setup/drill incomplete', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Begin recovery setup' })).toBeDisabled();
      const before = await page.evaluate(() => window.callie.recovery.status());
      expect(before.setupCompletedAt).toBeNull();
      await page.getByLabel('I understand this reveals private recovery material').check();
      await page.getByRole('button', { name: 'Begin recovery setup' }).click();
      await expect(page.getByLabel('One-time recovery material')).toHaveText(/^CALLIE1-/);
      expect(await page.evaluate(() => Object.keys(window.callie.recovery).sort())).toEqual(['beginSetup', 'completeSetup', 'saveSetupMaterial', 'selectAndRunRestoreDrill', 'status']);
      // Explicit fixture confirmation, without claiming a native Save occurred.
      await page.getByLabel('I stored the recovery material privately').check();
      await page.getByRole('button', { name: 'Complete recovery setup' }).click();
      await expect(page.getByLabel('One-time recovery material')).toHaveCount(0);
      const after = await page.evaluate(() => window.callie.recovery.status());
      setupCompletedAt = after.setupCompletedAt;
      expect(setupCompletedAt).not.toBeNull();
      expect(after.lastRestoreDrillAt).toBeNull();
      expect(after.outreachReady).toBe(false);
      expect(JSON.stringify(after)).not.toContain('CALLIE1-');
    });
    await inspectPackagedApplication(userDataPath, async (page) => {
      await page.getByRole('button', { name: 'Data & storage', exact: true }).click();
      await expect(page.getByLabel('One-time recovery material')).toHaveCount(0);
      const status = await page.evaluate(() => window.callie.recovery.status());
      expect(status.setupCompletedAt).toBe(setupCompletedAt);
      expect(status.outreachReady).toBe(false);
    });
  } finally { await rm(userDataPath, { recursive: true, force: true }); }
});

test('packaged startup leaves an isolated database collision untouched and recovers on relaunch', async () => {
  test.setTimeout(45_000);
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

    // Failed eager startup stays rendererless while awaiting native fatal Quit.
    // Recovery below is a separate clean launch, not native Restart acceptance.
    await rm(databasePath, { recursive: true });
    const health = await inspectPackagedApplication(userDataPath);

    expect(health).toEqual({
      databasePath,
      schemaVersion: 24,
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

const inspectPackagedApplication = async (userDataPath: string, inspectRecovery?: (page: Page) => Promise<void>) => {
  const debuggingPort = await availablePort();
  const environment = await createPackagedTestEnvironment();
  let application: ChildProcess | undefined;
  let browser: Browser | undefined;
  let spawnError: Error | undefined;

  try {
    // The packaged binary intentionally disables RunAsNode. Playwright's
    // Electron launcher requires that mode, so CDP inspects the real packaged
    // process without weakening the production fuse.
    assertPackagedApplicationIdentity(packagedApplication);
    application = environment.capture(spawn(packagedApplication, [
      `--user-data-dir=${userDataPath}`,
      `--remote-debugging-port=${debuggingPort}`,
      '--use-mock-keychain',
    ], { env: environment.env }));
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
    await expect(page.getByText('Schema 24')).toBeVisible();
    // The status row uses the isolated local fixture inbox. The separate
    // enrichment fallback also sees only the empty child HOME. Automatic
    // polling stays disabled under --use-mock-keychain.
    // It lives in the Sourcing section of the settings master-detail.
    await page.getByRole('button', { name: 'Sourcing', exact: true }).click();
    await expect(page.getByText(/^Sourcing inbox: /)).toBeVisible();

    await inspectRecovery?.(page);
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
      await environment.cleanup();
    }
  }
};

type CapturedOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

const inspectFailedPackagedLaunch = async (userDataPath: string) => {
  const debuggingPort = await availablePort();
  const environment = await createPackagedTestEnvironment();
  const observation = new AbortController();
  let rendererOutcome: Promise<CapturedOutcome<boolean>> | undefined;
  let exitOutcome: Promise<CapturedOutcome<{ code: number | null; signal: NodeJS.Signals | null }>> | undefined;
  try {
    assertPackagedApplicationIdentity(packagedApplication);
    const launchedAfter = Date.now() / 1000;
    const application = environment.capture(spawn(packagedApplication, [
      `--user-data-dir=${userDataPath}`,
      `--remote-debugging-port=${debuggingPort}`,
      '--use-mock-keychain',
    ], { env: environment.env }));
    // Arm immediately, handle rejection immediately, and retain the exact child.
    exitOutcome = waitForPackagedExit(application, 20_000).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    rendererOutcome = observeRendererPageUntilExit(application, debuggingPort, observation.signal)
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    if (application.pid === undefined || application.pid <= 1) throw new Error('Failed startup has no owned child PID.');
    const executable = await realpath(packagedApplication);
    if (application.exitCode !== null || application.signalCode !== null) throw new Error('Owned startup child exited before native observation.');
    const receipt = await pressOwnedStartupQuit(application.pid, executable, launchedAfter);
    await test.info().attach('owned-native-startup-quit', { body: JSON.stringify(receipt), contentType: 'application/json' });
    const exit = await exitOutcome;
    if (exit.ok === false) throw exit.error;
    const renderer = await rendererOutcome;
    if (renderer.ok === false) throw renderer.error;
    // A signal or cleanup termination never counts as native Quit success.
    expect(exit.value).toEqual({ code: 0, signal: null });
    return { exitCode: exit.value.code, signalCode: exit.value.signal, rendererPageObserved: renderer.value };
  } finally {
    observation.abort();
    // Cleanup starts even if the CDP observer is still disconnecting. Join all
    // owned work; cleanup signals are failure-path safety, never returned success.
    const cleanup = environment.cleanup();
    await Promise.allSettled([rendererOutcome, cleanup, exitOutcome]);
    await cleanup;
  }
};

const pressOwnedStartupQuit = async (pid: number, executable: string, launchedAfter: number) => {
  if (process.platform !== 'darwin') throw new Error('Native startup dialog proof requires macOS.');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('/usr/bin/swift', [join(__dirname, '../support/nativeStartupDialog.swift'), String(pid), executable, String(launchedAfter)],
      { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 8192 },
      (error, output) => { if (error) reject(new Error('Owned native startup dialog helper failed.')); else resolve(output); });
  });
  const receipt: unknown = JSON.parse(stdout);
  expect(receipt).toEqual({ formatVersion: 1, pid, executable, processStart: { seconds: expect.any(Number), microseconds: expect.any(Number) }, observed: true, pressed: true,
    message: 'Callie startup did not complete.',
    detail: 'APPLICATION_STARTUP_FAILED\nQuit Callie to close this attempt. If Restart Callie is offered, you can try starting it again.',
    buttons: ['Quit', 'Restart Callie'] });
  if (typeof receipt !== 'object' || receipt === null || !('processStart' in receipt)
    || typeof receipt.processStart !== 'object' || receipt.processStart === null
    || !('seconds' in receipt.processStart) || !('microseconds' in receipt.processStart)
    || typeof receipt.processStart.seconds !== 'number' || !Number.isSafeInteger(receipt.processStart.seconds)
    || receipt.processStart.seconds <= 0 || typeof receipt.processStart.microseconds !== 'number'
    || !Number.isSafeInteger(receipt.processStart.microseconds)
    || receipt.processStart.microseconds < 0 || receipt.processStart.microseconds >= 1_000_000) {
    throw new Error('Native startup receipt identity mismatch.');
  }
  const startedAt = receipt.processStart.seconds + receipt.processStart.microseconds / 1_000_000;
  if (!Number.isFinite(startedAt) || startedAt < launchedAfter - 2 || startedAt > Date.now() / 1000 + 1) {
    throw new Error('Native startup receipt identity mismatch.');
  }
  return receipt;
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
  signal: AbortSignal,
): Promise<boolean> => {
  let observed = false;
  const deadline = Date.now() + 21_000;
  while (!signal.aborted && application.exitCode === null && application.signalCode === null) {
    if (Date.now() >= deadline) throw new Error('Renderer observation deadline exceeded.');
    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${debuggingPort}`,
        { timeout: 100 },
      );
      if (browser.contexts().some((context) => context.pages().length > 0)) {
        observed = true;
      }
    } catch {
      // The debugger may not be listening yet, or startup may already be exiting.
    } finally {
      if (browser) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([browser.close(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Renderer observer disconnect timed out.')), 1_000);
          })]);
        } finally { clearTimeout(timer); }
      }
    }
    if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return observed;
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
