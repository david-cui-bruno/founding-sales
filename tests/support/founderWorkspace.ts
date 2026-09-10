import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, expect, type Browser, type Page } from 'playwright/test';
import { assertPackagedApplicationIdentity, describeProcessExit, packagedApplicationBinary } from './packagedApplication';
import { createPackagedTestEnvironment } from './packagedTestEnvironment';

export { packagedApplicationBinary } from './packagedApplication';

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
    assertPackagedApplicationIdentity(packagedApplicationBinary);
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

const secondaryRoutes = new Set(['Leads', 'Pipeline', 'Conversations', 'Learnings', 'Inbox', 'Friday']);

const routeHref = (label: string): string => `#/${label.toLowerCase()}`;

export const inboxRouteName = /^Inbox\s*(?:\d+ open local reviews|Checking local reviews|Local review count unavailable)$/;

export async function navigateFounderRoute(page: Page, label: string): Promise<void> {
  const navigation = page.getByRole('navigation', { name: 'Primary', exact: true });
  await expect(navigation).toBeVisible();

  const linkName = label === 'Inbox' ? inboxRouteName : label;
  const link = navigation.getByRole('link', { name: linkName, exact: true });

  if (secondaryRoutes.has(label) && !(await link.isVisible())) {
    const more = navigation.getByRole('button', { name: 'More workspaces', exact: true });
    await expect(more).toHaveAttribute('aria-expanded', /^(?:true|false)$/);
    if ((await more.getAttribute('aria-expanded')) !== 'true') {
      await more.click();
    }
    await expect(more).toHaveAttribute('aria-expanded', 'true');
  }

  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', routeHref(label));
  await expect(link.locator('.nav-rail__label')).toHaveText(label);
  if (label === 'Inbox') {
    const badge = link.locator('.nav-rail__badge');
    await expect(badge).toHaveAttribute('aria-label', /^(?:\d+ open local reviews|Checking local reviews|Local review count unavailable)$/);
    const badgeSnapshot = await badge.evaluate((node) => ({
      text: node.textContent?.trim() ?? '',
      label: node.getAttribute('aria-label'),
    }));
    expect(badgeSnapshot.label).toMatch(/^(?:\d+ open local reviews|Checking local reviews|Local review count unavailable)$/);
    if (/^\d+ open local reviews$/.test(badgeSnapshot.label ?? '')) {
      expect(badgeSnapshot.text).toBe((badgeSnapshot.label ?? '').replace(/ open local reviews$/, ''));
    } else if (badgeSnapshot.label === 'Checking local reviews') {
      expect(badgeSnapshot.text).toBe('…');
    } else {
      expect(badgeSnapshot.text).toBe('?');
    }
  }
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
}

export async function expectCleanInboxReadyZero(page: Page): Promise<void> {
  await navigateFounderRoute(page, 'Inbox');
  const inbox = page.getByRole('link', { name: /^Inbox\s*0 open local reviews$/, exact: true });
  await expect(inbox.locator('.nav-rail__badge')).toHaveText('0');
  await expect(inbox.locator('.nav-rail__badge')).toHaveAttribute('aria-label', '0 open local reviews');
  await expect(page.getByRole('heading', { name: /^Inbox\s*·\s*0 open local reviews$/ })).toBeVisible();
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
    await navigateFounderRoute(page, 'Leads');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page
      .getByLabel('CSV file')
      .setInputFiles(workflowFixture('first-week-leads.csv'));
    await page.getByRole('button', { name: 'Preview rows' }).click();
    await page.getByText('3 rows ready').waitFor();
    await page.getByRole('button', { name: 'Import 3 rows' }).click();
    // Finish the real modal workflow before interacting with its inert backdrop.
    const dialog = page.getByRole('dialog', { name: 'Import leads', exact: true });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('row', { name: /Kevin Shin/ }).waitFor();
    return workspace;
  } catch (error) {
    await workspace.close();
    throw error;
  }
}
