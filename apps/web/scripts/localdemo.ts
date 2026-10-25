import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { assertSyntheticNoSend, containSyntheticBrowser, signInSyntheticBrowser, startSyntheticBrowser, requireLocalDemo } from '../test/support/syntheticBrowserApp.ts';
import { syntheticBrowserCase, syntheticReplySource } from '../test/support/syntheticBrowserCase.ts';

// Run from repository root: FSS_SYNTHETIC_LOCAL_DEMO=1 npm run localdemo --workspace apps/web
// Ctrl-C or SIGTERM this exact Node PID. All state is deleted, never shared Chrome/Homebrew PG.
requireLocalDemo(process.env);
// initdb inherits locale. A clean shell otherwise creates SQL_ASCII on macOS.
process.env['LC_ALL'] = 'en_US.UTF-8';
const lifetime = Number(process.env['FSS_LOCAL_DEMO_MINUTES'] ?? '20');
if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 30) throw Error('Demo lifetime must be 1..30 minutes');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await access(chrome);
const profile = await mkdtemp(join(tmpdir(), 'fss-synthetic-781-chrome-'));
let runtime: Awaited<ReturnType<typeof startSyntheticBrowser>> | undefined;
let context: BrowserContext | undefined;
let finish = (): void => {};
const closed = new Promise<void>(resolve => { finish = resolve; });
const onSignal = (): void => { finish(); };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
process.on('SIGHUP', onSignal);
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const signalListeners = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
const expiresAt = new Date(Date.now() + lifetime * 60_000).toISOString();
const timer = setTimeout(finish, lifetime * 60_000);
try {
  try { runtime = await startSyntheticBrowser(); }
  finally {
    // embedded-postgres imports async-exit-hook. Its signal hooks exit before
    // application finally blocks can finish. This dedicated CLI owns shutdown.
    for (const signal of signals) for (const listener of process.listeners(signal)) {
      if (!signalListeners.get(signal)!.has(listener)) process.removeListener(signal, listener);
    }
  }
  context = await chromium.launchPersistentContext(profile, { executablePath: chrome, headless: false, ignoreHTTPSErrors: true, serviceWorkers: 'block', acceptDownloads: false, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  context.on('close', finish);
  await containSyntheticBrowser(context, runtime.app);
  const page = context.pages()[0] ?? await context.newPage();
  await signInSyntheticBrowser(page, runtime.app);
  await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
  await page.getByRole('button', { name: `${syntheticBrowserCase.firm}: ${syntheticReplySource.subject}`, exact: true }).click();
  await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
  await page.getByText(syntheticReplySource.body, { exact: true }).waitFor();
  await page.locator('#replies').scrollIntoViewIfNeeded();
  await assertSyntheticNoSend(runtime.app);
  const receipt = { issue: 781, pid: process.pid, origin: runtime.app.origin, oidcIssuer: runtime.app.fixture.google.issuer, profile, storagePath: runtime.app.storagePath, postgresPid: runtime.app.postgresPid, tlsPath: runtime.app.tlsPath, database: runtime.app.fixture.database.name, meetingId: runtime.app.meetingId, expiresAt, stop: `kill -TERM ${process.pid}`, sendingEnabled: false, model: 'fixed fixture script, no live inference' };
  await writeFile(join(profile, 'resource-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.error('SYNTHETIC_BROWSER_DEMO_READY', JSON.stringify(receipt));
  console.error('Use the labeled Chrome window. Fictional input is open in Replies. Generate is an explicit scripted action. Ctrl-C stops and erases this entire disposable demo.');
  await closed;
  await assertSyntheticNoSend(runtime.app);
} finally {
  clearTimeout(timer);
  try { await context?.close(); }
  finally {
    try { await runtime?.stop(); }
    finally { await rm(profile, { recursive: true, force: true }); }
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  process.off('SIGHUP', onSignal);
  console.error('SYNTHETIC_BROWSER_DEMO_STOPPED: owned HTTPS, OIDC, database, cluster, TLS and Chrome profile removed');
}
