import { pathToFileURL } from 'node:url';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { assertSyntheticNoSend, containSyntheticBrowser, signInSyntheticBrowser, startSyntheticBrowser, requireLocalDemo, prepareSyntheticCliDependency } from '../test/support/syntheticBrowserApp.ts';
import { syntheticBrowserCase, syntheticReplySource } from '../test/support/syntheticBrowserCase.ts';

// See localdemo.md for the clean-environment command and exact-owned stop policy.
export async function runLocalDemo(options: { reviewWindow?: boolean; stopCommand?: string; onReady?: (receipt: Record<string, unknown>) => Promise<void>; onStopping?: () => Promise<void> } = {}): Promise<void> {
  requireLocalDemo(process.env);
  // initdb inherits locale. A clean shell otherwise creates SQL_ASCII on macOS.
  process.env['LC_ALL'] = 'en_US.UTF-8';
  const lifetime = Number(process.env['FSS_LOCAL_DEMO_MINUTES'] ?? '20');
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 30) throw Error('Demo lifetime must be 1..30 minutes');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  let profile: string | undefined;
  let runtime: Awaited<ReturnType<typeof startSyntheticBrowser>> | undefined;
  let context: BrowserContext | undefined;
  let stopping: Promise<void> | undefined;
  const publishStopping = (): Promise<void> => stopping ??= Promise.resolve().then(() => options.onStopping?.());
  let shutdownRequested = false;
  let finish = (): void => {};
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const requestShutdown = (): void => { shutdownRequested = true; finish(); };
  const onSignal = (): void => {
    console.error('SYNTHETIC_BROWSER_SHUTDOWN_REQUESTED', JSON.stringify({ duringStartup: runtime === undefined }));
    requestShutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  let expiresAt = new Date(Date.now() + lifetime * 60_000).toISOString();
  let timer = setTimeout(requestShutdown, lifetime * 60_000);
  const cancelled = (): boolean => {
    if (!shutdownRequested) return false;
    console.error('SYNTHETIC_BROWSER_STARTUP_CANCELLED', JSON.stringify({ pid: process.pid, profile, origin: runtime?.app.origin, oidcIssuer: runtime?.app.fixture.google.issuer }));
    return true;
  };
  try {
    // Reclaim dependency-only terminating hooks immediately around import, before
    // PG initialization, migration, auth, TLS, asset building or profile creation.
    await prepareSyntheticCliDependency();
    console.error('SYNTHETIC_BROWSER_DEPENDENCY_READY');
    if (cancelled()) return;
    await access(chrome);
    if (cancelled()) return;
    profile = await mkdtemp(join(tmpdir(), 'fss-synthetic-781-chrome-'));
    console.error('SYNTHETIC_BROWSER_STARTING', JSON.stringify({ pid: process.pid, profile, expiresAt }));
    if (cancelled()) return;
    runtime = await startSyntheticBrowser();
    // A signal during startup lets existing owners finish safely, then unwinds.
    // It never launches Chrome or announces a ready demo after cancellation.
    if (cancelled()) return;
    context = await chromium.launchPersistentContext(profile, { executablePath: chrome, headless: false, ignoreHTTPSErrors: true, serviceWorkers: 'block', acceptDownloads: false, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    context.on('close', requestShutdown);
    if (cancelled()) return;
    await containSyntheticBrowser(context, runtime.app);
    const page = context.pages()[0] ?? await context.newPage();
    await signInSyntheticBrowser(page, runtime.app);
    if (cancelled()) return;
    await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
    await page.getByRole('button', { name: `${syntheticBrowserCase.firm}: ${syntheticReplySource.subject}`, exact: true }).click();
    await page.getByRole('button', { name: 'Refresh current reply context', exact: true }).click();
    await page.getByText(syntheticReplySource.body, { exact: true }).waitFor();
    await page.locator('#replies').scrollIntoViewIfNeeded();
    await assertSyntheticNoSend(runtime.app);
    if (cancelled()) return;
    if (options.reviewWindow) {
      clearTimeout(timer);
      expiresAt = new Date(Date.now() + lifetime * 60_000).toISOString();
      timer = setTimeout(requestShutdown, lifetime * 60_000);
    }
    const receipt = { issue: 781, pid: process.pid, origin: runtime.app.origin, oidcIssuer: runtime.app.fixture.google.issuer, profile, storagePath: runtime.app.storagePath, postgresPid: runtime.app.postgresPid, tlsPath: runtime.app.tlsPath, database: runtime.app.fixture.database.name, meetingId: runtime.app.meetingId, expiresAt, stop: options.stopCommand ?? `kill -TERM ${process.pid}`, sendingEnabled: false, model: 'fixed fixture script, no live inference', runtimeRoleChecks: runtime.app.runtimeRoleChecks() };
    await writeFile(join(profile, 'resource-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (cancelled()) return;
    await options.onReady?.(receipt);
    if (cancelled()) return;
    console.error('SYNTHETIC_BROWSER_DEMO_READY', JSON.stringify(receipt));
    console.error('Use the labeled Chrome window. Fictional input is open in Replies. Generate is an explicit scripted action. Ctrl-C stops and erases this entire disposable demo.');
    await closed;
    await publishStopping();
    await assertSyntheticNoSend(runtime.app);
  } finally {
    clearTimeout(timer);
    try { await publishStopping(); }
    finally {
      try { await context?.close(); }
      finally {
        try { await runtime?.stop(); }
        finally {
          if (profile) await rm(profile, { recursive: true, force: true });
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          process.off('SIGHUP', onSignal);
        }
      }
    }
    console.error('SYNTHETIC_BROWSER_DEMO_STOPPED: owned HTTPS, OIDC, database, cluster, TLS and Chrome profile removed');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runLocalDemo();
