import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { chromium, expect, test, type Browser } from 'playwright/test';

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
  const userDataPath = await mkdtemp(join(tmpdir(), 'callie-foundation-e2e-'));
  const debuggingPort = await availablePort();
  let application: ChildProcess | undefined;
  let browser: Browser | undefined;

  try {
    expect(existsSync(packagedApplication)).toBe(true);

    // The packaged binary intentionally disables RunAsNode. Playwright's
    // Electron launcher requires that mode, so CDP inspects the real packaged
    // process without weakening the production fuse.
    application = spawn(packagedApplication, [
      `--user-data-dir=${userDataPath}`,
      `--remote-debugging-port=${debuggingPort}`,
    ]);
    browser = await connectToPackagedApplication(application, debuggingPort);
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
    const expectedDatabasePath = join(await realpath(userDataPath), 'callie.sqlite3');

    expect(health.databasePath).toBe(expectedDatabasePath);
    expect(health.databasePath).not.toContain('Application Support');
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
    await browser?.close();
    application?.kill('SIGTERM');
    await rm(userDataPath, { recursive: true, force: true });
  }
});

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
): Promise<Browser> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (application.exitCode !== null) {
      throw new Error(`The packaged application exited with code ${application.exitCode}.`);
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
