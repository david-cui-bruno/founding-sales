import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
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
      schemaVersion: 1,
      fts5Available: true,
    });
    expect(secondLaunch).toEqual(firstLaunch);
    expect(existsSync(expectedDatabasePath)).toBe(true);

    const database = new Database(expectedDatabasePath, { readonly: true });
    try {
      expect(
        database
          .prepare('SELECT schema_version FROM app_meta WHERE singleton = 1')
          .get(),
      ).toEqual({ schema_version: 1 });
    } finally {
      database.close();
    }
  } finally {
    if (userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});

test('packaged diagnostics retry the same isolated database path after a transient open failure', async () => {
  let userDataPath: string | undefined;

  try {
    userDataPath = await mkdtemp(join(tmpdir(), 'callie-foundation-retry-e2e-'));
    const databasePath = join(await realpath(userDataPath), 'callie.sqlite3');
    await mkdir(databasePath, { mode: 0o700 });

    const health = await inspectPackagedRetry(userDataPath, databasePath);

    expect(health).toEqual({
      databasePath,
      schemaVersion: 1,
      fts5Available: true,
    });
    expect(existsSync(databasePath)).toBe(true);
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

    await expect(
      page.getByRole('heading', { name: 'Callie Founder Sales System' }),
    ).toBeVisible();
    await expect(page.getByText('SQLite ready')).toBeVisible();
    await expect(page.getByText('FTS5 available')).toBeVisible();
    await expect(page.getByText('Schema 1')).toBeVisible();
    await expect(page.getByText('Active job count')).toBeVisible();
    await expect(page.getByText('Recovery count')).toBeVisible();
    await expect(page).toHaveURL('callie://app/index.html');

    const health = await page.evaluate(() => window.callie.health.get());
    return {
      databasePath: health.databasePath,
      schemaVersion: health.schemaVersion,
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

const inspectPackagedRetry = async (
  userDataPath: string,
  databasePath: string,
) => {
  const debuggingPort = await availablePort();
  let application: ChildProcess | undefined;
  let browser: Browser | undefined;
  let spawnError: Error | undefined;

  try {
    application = spawn(packagedApplication, [
      `--user-data-dir=${userDataPath}`,
      `--remote-debugging-port=${debuggingPort}`,
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

    await expect(page.getByRole('alert')).toContainText(
      'The local database could not be opened',
    );
    await expect(page.getByText('LOCAL_DATABASE_UNAVAILABLE')).toBeVisible();
    await expect(page).toHaveURL('callie://app/index.html');
    expect(existsSync(databasePath)).toBe(true);

    // This is an isolated test-created directory collision, never a database.
    await rm(databasePath, { recursive: true });
    await page.getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByText('SQLite ready')).toBeVisible();
    await expect(page.getByText('FTS5 available')).toBeVisible();
    await expect(page.getByText('Schema 1')).toBeVisible();
    const health = await page.evaluate(() => window.callie.health.get());
    return {
      databasePath: health.databasePath,
      schemaVersion: health.schemaVersion,
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

    try {
      return await chromium.connectOverCDP(
        `http://127.0.0.1:${debuggingPort}`,
      );
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error('Timed out waiting for the packaged application debugger.');
};
