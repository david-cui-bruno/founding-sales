import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type BrowserContext, type Page } from 'playwright/test';
import { createOwnedTeardown } from '@fss/domain/db/testing/globalSetup.ts';
import { CURRENT_CLIENT_VERSION } from '../../../api/test/support/authFixture.ts';
import { reserveLocalBrowserDatabase } from './database.ts';
import { startReplyBriefApp, type ReplyBriefApp } from './replyBriefApp.ts';
import { containSyntheticBrowser, requireLocalDemo } from './syntheticBrowserApp.ts';
import type { SyntheticCase } from './syntheticBusinessFixture.ts';
import { listenerAbsent } from './founderHostResources.ts';

export const glassCase: SyntheticCase = {
  id: 'A', title: 'FICTIONAL GLASS783, no contact', firm: 'FICTIONAL Glassbrook Property Team',
  participants: [{ name: 'FICTIONAL Rowan Glass', email: 'rowan@glassbrook.example.test', role: 'manager' }],
  messages: [
    { id: 'GLASS783-1', direction: 'inbound', from: 'rowan@glassbrook.example.test', to: ['founder@example.test'], sentAt: '2026-10-23T13:00:00Z', subject: 'FICTIONAL GLASS783 workflow question', body: 'FICTIONAL GLASS783 ORIGINAL ONE: We manage 42 rental homes. Who owns an unanswered vendor request?' },
    { id: 'GLASS783-2', direction: 'outbound', from: 'founder@example.test', to: ['rowan@glassbrook.example.test'], sentAt: '2026-10-23T14:00:00Z', subject: 'FICTIONAL GLASS783 workflow question', body: ['FICTIONAL GLASS783 ORIGINAL TWO: This is a private screen discussion, not a live repair dispatch.', ...Array.from({ length: 36 }, (_, index) => `FICTIONAL retained context-only paragraph ${index + 1}. No live action.`)].join('\n') },
    { id: 'GLASS783-3', direction: 'inbound', from: 'rowan@glassbrook.example.test', to: ['founder@example.test'], sentAt: '2026-10-23T15:00:00Z', subject: 'FICTIONAL GLASS783 current question', body: 'FICTIONAL GLASS783 CURRENT ORIGINAL: Please explain the request handoff. No calendar booking or sending is authorized.' },
  ],
};

/** This guard is intentionally before every resource allocation. Setting it is a
 * root-coordinator action after schema composition, not permission inferred by a test. */
export function requireGlassRuntimeGrant(): void {
  assert.equal(process.env['FSS_GLASS_WORKSPACE_EXCLUSIVE_LANE'], '783', 'Explicit root sole-lane grant required');
  requireLocalDemo(process.env);
  assert(process.env['FSS_LOCAL_BROWSER_EXECUTABLE'], 'Use the installed, explicitly selected Chrome');
  const servers = execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' }).split('\n')
    .filter(line => /(?:^|\s)(?:\S*\/)?postgres(?:\s|$)/u.test(line) && !/postgres: /u.test(line));
  assert(servers.every(line => line.includes('/opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17')), 'Another disposable PostgreSQL lane is active');
}

export async function startGlassWorkspace() {
  requireGlassRuntimeGrant();
  await access(process.env['FSS_LOCAL_BROWSER_EXECUTABLE']!);
  const homebrew1106 = execFileSync('ps', ['-p', '1106', '-o', 'command='], { encoding: 'utf8' }).trim();
  assert(homebrew1106.includes('/opt/homebrew/opt/postgresql@17/bin/postgres'), 'Preserve root-designated Homebrew1106');
  const release = await reserveLocalBrowserDatabase();
  let app: ReplyBriefApp | undefined;
  try {
    // Exported createBrowserServer, current bundled product, signed OIDC and real
    // API/domain. Every request checks app_runtime. No frontend fixture injection.
    app = await startReplyBriefApp({ conversation: glassCase, requestDatabaseRole: 'app_runtime' });
    const owned = app;
    const httpsPort = Number(new URL(owned.origin).port), oidcPort = Number(new URL(owned.fixture.google.issuer).port);
    console.log('GLASS783_REGISTERED_RUNTIME', JSON.stringify({ origin: owned.origin, oidcIssuer: owned.fixture.google.issuer, httpsPort, oidcPort, clientVersion: CURRENT_CLIENT_VERSION, supportedClientVersions: owned.fixture.deps.config.supportedClientVersions, database: owned.fixture.database.name, template: process.env['FSS_TEST_TEMPLATE_DATABASE'], postgresPid: owned.postgresPid, storagePath: owned.storagePath, tlsPath: owned.tlsPath, requestRole: 'app_runtime', sendingEnabled: false, homebrew1106 }));
    return { app: owned, stop: createOwnedTeardown([
      () => owned.stop(),
      async () => { await listenerAbsent(httpsPort, 'localhost'); await listenerAbsent(oidcPort, 'localhost'); },
      release,
      async () => {
        await access(owned.storagePath).then(() => { throw Error('Owned PG storage remains'); }, error => { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); });
        assert.throws(() => process.kill(owned.postgresPid, 0), { code: 'ESRCH' });
        assert.equal(execFileSync('ps', ['-p', '1106', '-o', 'command='], { encoding: 'utf8' }).trim(), homebrew1106, 'Homebrew1106 remains untouched');
        console.log('GLASS783_RUNTIME_RELEASED', JSON.stringify({ postgresPid: owned.postgresPid, storagePath: owned.storagePath, httpsPort, oidcPort, homebrew1106Unchanged: true }));
      },
    ]) };
  } catch (error) {
    try { await createOwnedTeardown([async () => { await app?.stop(); }, release])(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Glass startup and owned cleanup failed'); }
    throw error;
  }
}
export type GlassWorkspaceApp = Awaited<ReturnType<typeof startGlassWorkspace>>['app'];

export async function containGlass(context: BrowserContext, app: GlassWorkspaceApp): Promise<void> {
  // Only signed test-provider navigation is remapped. All external requests abort.
  await containSyntheticBrowser(context, app);
}
export async function signInGlass(page: Page, app: GlassWorkspaceApp, identity: 'admin' | 'salesperson' = 'admin'): Promise<void> {
  app.chooseIdentity(app.fixture.alpha[identity]);
  await page.goto(app.origin);
  await page.getByLabel('Workspace ID', { exact: true }).fill(app.fixture.alpha.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}
export async function navigateGlass(page: Page, name: 'Today' | 'Prospects' | 'Calling' | 'Email' | 'Social'): Promise<void> {
  await page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('#workspace-main')).toBeFocused();
}
export async function assertGlassStorage(page: Page, privateTexts: string[]): Promise<void> {
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  for (const text of privateTexts) expect(storage).not.toContain(text);
  expect(storage).not.toMatch(/accessToken|deviceSecret|handoffSecret|id_token|code_verifier/u);
}
export async function assertGlassNoExternalActions(app: GlassWorkspaceApp, retainedOutboundCount = 0): Promise<void> {
  assert.equal(app.calls(), 0, 'No scripted or live inference requested');
  assert(app.runtimeRoleChecks() > 0, 'Actual app_runtime requests required');
  assert.equal((await app.fixture.db.query('SELECT 1 FROM outbound_messages')).rowCount, retainedOutboundCount, 'Only explicitly seeded inert history may exist');
  for (const table of ['human_reply_send_intents', 'social_posts', 'social_deliveries', 'provider_reservations']) {
    assert.equal((await app.fixture.db.query(`SELECT 1 FROM ${table}`)).rowCount, 0, table);
  }
  assert.equal((await app.fixture.db.query("SELECT 1 FROM jobs WHERE kind IN ('reply.human_send','social.publish')")).rowCount, 0);
}
export async function assertGlassFits(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
export async function glassScreenshot(page: Page, name: string): Promise<void> {
  const directory = process.env['FSS_GLASS_PRIVATE_ARTIFACTS'];
  assert(directory && directory.startsWith('/Users/davidcui824/.jcode/scratch/'), 'Private scratch artifacts required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `${name}.png`);
  await page.screenshot({ path });
  await chmod(path, 0o600);
}
