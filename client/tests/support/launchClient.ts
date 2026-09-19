import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from 'playwright/test';
import type { StubWorker } from '../stubWorker';

/**
 * Launches the built client (see `tests/support/globalSetup.ts`) as a real Electron application with an
 * isolated userData directory and the stub worker as its endpoint. Both overrides are read by the main
 * process only when the app is not packaged.
 */
export const clientRoot = resolve(__dirname, '..', '..');
const electronDirectory = join(clientRoot, 'node_modules', 'electron');
export const electronExecutable = join(
  electronDirectory,
  'dist',
  readFileSync(join(electronDirectory, 'path.txt'), 'utf8').trim(),
);

export type LaunchedClient = {
  app: ElectronApplication;
  page: Page;
  userData: string;
  close(): Promise<void>;
};

export const newUserData = (): Promise<string> => mkdtemp(join(tmpdir(), 'callie-client-spec-'));

/** A file under the client's own directory beneath userData, where the token and last-good files live. */
export const clientFile = (userData: string, name: string): string => join(userData, 'client', name);

export async function launchClient(options: { endpoint: string; userData: string }): Promise<LaunchedClient> {
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [clientRoot],
    cwd: clientRoot,
    env: {
      ...process.env,
      CALLIE_WORKER_ENDPOINT: options.endpoint,
      CALLIE_CLIENT_USER_DATA: options.userData,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return {
    app,
    page,
    userData: options.userData,
    close: async () => { await app.close(); },
  };
}

export const codeField = (page: Page) => page.getByLabel('Pairing code or the path of the code file', { exact: true });
export const pairButton = (page: Page) => page.getByRole('button', { name: 'Pair', exact: true });

/** The heading of the landing page after pairing: Today, the morning list. */
export const todayHeading = (page: Page) => page.getByRole('heading', { name: 'Today', exact: true, level: 1 });
export const diagnosticsHeading = (page: Page) => page.getByRole('heading', { name: 'Diagnostics', exact: true, level: 1 });

/** Pairs through the real Pair page with a code the stub minted, and waits for the Today landing page. */
export async function pairThroughUi(page: Page, stub: StubWorker, label = 'David MacBook'): Promise<string> {
  await expect(page.getByRole('heading', { name: 'Pair this Mac', exact: true })).toBeVisible();
  const code = stub.mintCode(label);
  await codeField(page).fill(code);
  await pairButton(page).click();
  await expect(todayHeading(page)).toBeVisible();
  return code;
}

/** Navigates to Diagnostics through the rail, for a spec that needs that page. */
export async function openDiagnostics(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(diagnosticsHeading(page)).toBeVisible();
}
