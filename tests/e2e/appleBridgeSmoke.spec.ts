import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, expect, test, type Browser, type Dialog } from 'playwright/test';

import {
  assertPackagedDescendantsExit,
  describeProcessExit,
  packagedApplicationBinary as packagedApplication,
  assertPackagedApplicationIdentity,
  snapshotPackagedProcessTree,
  waitForPackagedChildProcess,
  type PackagedProcessEntry,
} from '../support/packagedApplication';
import { createPackagedTestEnvironment, type PackagedTestEnvironment } from '../support/packagedTestEnvironment';

test('packaged Apple helper handshakes and exits without permission or communication actions', async () => {
  let userDataPath: string | undefined;
  let application: ChildProcess | undefined;
  let environment: PackagedTestEnvironment | undefined;
  let browser: Browser | undefined;
  let trackedDescendants: PackagedProcessEntry[] = [];
  let spawnError: Error | undefined;
  const rendererDialogs: string[] = [];

  try {
    expect(existsSync(packagedApplication)).toBe(true);
    userDataPath = await mkdtemp(join(tmpdir(), 'callie-apple-smoke-e2e-'));
    const debuggingPort = await availablePort();
    environment = await createPackagedTestEnvironment();
    assertPackagedApplicationIdentity(packagedApplication);
    application = environment.capture(spawn(packagedApplication, [
      `--user-data-dir=${userDataPath}`,
      `--remote-debugging-port=${debuggingPort}`,
      '--use-mock-keychain',
      '--apple-feasibility-spike',
    ], { env: environment.env }));
    application.once('error', (error) => {
      spawnError = error;
    });
    if (application.pid === undefined) {
      throw new Error('The packaged application did not receive a process ID.');
    }

    const appleBridge = await waitForPackagedChildProcess(
      application.pid,
      (entry) => /(?:^|\/)CallieAppleBridge(?:\s|$)/u.test(entry.command),
      { timeoutMs: 20_000 },
    );
    trackedDescendants = unionProcessEntries([appleBridge]);
    trackedDescendants = unionProcessEntries(
      trackedDescendants,
      await snapshotPackagedProcessTree(application.pid),
    );
    expect(trackedDescendants).toContainEqual(appleBridge);

    browser = await connectToPackagedApplication(
      application,
      debuggingPort,
      () => spawnError,
    );
    const page = browser.contexts()[0]?.pages()[0];
    if (page === undefined) {
      throw new Error('The packaged application did not create a renderer page.');
    }
    page.on('dialog', (dialog: Dialog) => {
      rendererDialogs.push(dialog.message());
      void dialog.dismiss();
    });

    // The Apple feasibility panel now lives behind the Settings route.
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Apple feasibility spike' }),
    ).toBeVisible();
    await expect.poll(
      () => page.evaluate(() => window.callie.appleSpike.getStatus()),
      { timeout: 10_000 },
    ).toEqual({
      enabled: true,
      bridge: {
        state: 'ready',
        helperVersion: '1.0.0',
        protocolVersion: 1,
      },
    });
    await expect(page.getByText('Helper ready · v1.0.0')).toBeVisible();

    // The smoke deliberately performs status/handshake inspection only. These
    // controls remain untouched, so startup cannot request TCC permission,
    // inspect Apple databases, place a call, or send a message.
    await expect(
      page.getByRole('button', { name: 'Request Contacts access' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Request Accessibility access' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Start call observation' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Send test message' }),
    ).toBeDisabled();
    await expect(page.locator('.apple-spike__result')).toHaveCount(0);
    expect(rendererDialogs).toEqual([]);
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        if (application?.pid !== undefined) {
          if (application.exitCode === null && application.signalCode === null) {
            try {
              trackedDescendants = unionProcessEntries(
                trackedDescendants,
                await snapshotPackagedProcessTree(application.pid),
              );
            } catch {
              // The launched root may already be exiting; retained identities
              // still receive exact instance-safe cleanup verification below.
            }
          }
        }
        await environment?.cleanup();
        if (application?.pid !== undefined) {
          await assertPackagedDescendantsExit(trackedDescendants, {
            timeoutMs: 5_000,
          });
        }
      } finally {
        if (userDataPath !== undefined) {
          await rm(userDataPath, { recursive: true, force: true });
        }
      }
    }
  }
});

const unionProcessEntries = (
  ...groups: readonly PackagedProcessEntry[][]
): PackagedProcessEntry[] => [
  ...new Map(groups
    .flat()
    .map((entry) => [`${entry.pid}\0${entry.startedAt}`, entry] as const))
    .values(),
];

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
    const error = getSpawnError();
    if (error !== undefined) {
      throw new Error(`The packaged application failed to spawn: ${error.message}`);
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
