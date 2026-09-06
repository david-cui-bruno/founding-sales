import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright/test';
import { describeProcessExit } from './packagedApplication';
import { createPackagedTestEnvironment } from './packagedTestEnvironment';

export const packagedApplicationBinary = join(
  process.cwd(),
  'out',
  'Callie Founder Sales System-darwin-arm64',
  'Callie Founder Sales System.app',
  'Contents',
  'MacOS',
  'Callie Founder Sales System',
);

export type FounderWorkspace = {
  /** Captured child for observation, not proof of graceful exit. */
  readonly application: ChildProcess;
  page: Page;
  userDataPath: string;
  /** Terminates the app and browser but keeps the user-data directory. */
  stop(): Promise<void>;
  /** Terminates everything and removes only the temporary directory. */
  close(): Promise<void>;
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const spawnError = getSpawnError();
    if (spawnError !== undefined) {
      throw new Error(
        `The packaged application failed to spawn: ${spawnError.message}`,
      );
    }

    if (application.exitCode !== null || application.signalCode !== null) {
      throw new Error(
        `The packaged application exited before inspection (${describeProcessExit(application)}).`,
      );
    }

    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error('Timed out connecting to the packaged application.');
};

/**
 * Launches a normal GUI fixture with isolated child HOME/inbox and a temporary
 * user-data directory. stop() retains the profile for relaunch; close() removes
 * only a profile created here. Neither changes the runner HOME.
 */
export async function launchFounderWorkspace(options: {
  userDataPath?: string;
  /** Only the existing sourcing fixture-directory/hang-once test overrides. */
  env?: Record<string, string>;
  /** Synchronous observation before CDP connection or renderer discovery. */
  onSpawn?: (application: ChildProcess) => void;
} = {}): Promise<FounderWorkspace> {
  if (!existsSync(packagedApplicationBinary)) {
    throw new Error(
      'The packaged application is missing; run `npm run package` first.',
    );
  }

  const environment = await createPackagedTestEnvironment(options.env);
  let userDataPath = options.userDataPath;
  const ownsUserData = options.userDataPath === undefined;
  let browser: Browser | undefined;
  try {
    userDataPath ??= await mkdtemp(join(tmpdir(), 'callie-founder-e2e-'));
    const debuggingPort = await availablePort();
    let spawnError: Error | undefined;
    const application = environment.capture(spawn(packagedApplicationBinary, [
      `--user-data-dir=${userDataPath}`,
      `--remote-debugging-port=${debuggingPort}`,
      '--use-mock-keychain',
    ], { env: environment.env }));
    application.once('error', (error) => {
      spawnError = error;
    });
    options.onSpawn?.(application);
    browser = await connectToPackagedApplication(
      application,
      debuggingPort,
      () => spawnError,
    );

    let page: Page | undefined;
    for (let attempt = 0; attempt < 200 && page === undefined; attempt += 1) {
      page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith('callie://'));
      if (page === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (page === undefined) {
      throw new Error('The packaged application did not create a renderer page.');
    }

    const stop = async (): Promise<void> => {
      try {
        await browser?.close();
      } catch {
        // The browser may already be gone when the app exits first.
      } finally {
        await environment.cleanup();
      }
    };
    return {
      application,
      page,
      userDataPath,
      stop,
      close: async () => {
        await stop();
        if (ownsUserData) {
          await rm(userDataPath, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await browser?.close().catch((): undefined => undefined);
    await environment.cleanup();
    if (ownsUserData && userDataPath !== undefined) {
      await rm(userDataPath, { recursive: true, force: true });
    }
    throw error;
  }
}

export const workflowFixture = (name: string): string =>
  join(process.cwd(), 'tests', 'fixtures', 'founderWorkflow', name);

/**
 * Seeds a workspace through the real UI import flow, never by writing to
 * SQLite directly, and returns the running workspace on the Leads route.
 */
export async function launchSeededFounderWorkspace(): Promise<FounderWorkspace> {
  const workspace = await launchFounderWorkspace();

  try {
    const { page } = workspace;
    await page.getByRole('link', { name: 'Leads' }).click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page
      .getByLabel('CSV file')
      .setInputFiles(workflowFixture('first-week-leads.csv'));
    await page.getByRole('button', { name: 'Preview rows' }).click();
    await page.getByText('3 rows ready').waitFor();
    await page.getByRole('button', { name: 'Import 3 rows' }).click();
    await page.getByRole('row', { name: /Kevin Shin/ }).waitFor();
    return workspace;
  } catch (error) {
    await workspace.close();
    throw error;
  }
}
