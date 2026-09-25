import { join } from 'node:path';
import { app, BrowserWindow, protocol } from 'electron';
import { start } from './app.ts';
import {
  answerBundleRequest,
  BUNDLE_ENTRY_URL,
  BUNDLE_PRIVILEGES,
  BUNDLE_SCHEME,
} from './bundleScheme.ts';
import { startUpdateWatch } from './updater.ts';

/**
 * The entry point of the packaged bundle.
 *
 * `app.ts` is the Electron main process and deliberately stops at "open a window,
 * answer the bridge". This is the part that only a packaged build has: where its
 * configuration came from, what the update channel is, and which URLs the bundle is
 * willing to be opened with.
 *
 * The four values below are replaced at build time by `scripts/bundle.ts`. They are
 * public — an API hostname, a CloudFront hostname, a version, and the *public* half
 * of the update-signing key — and there is nowhere in this file for a secret to be.
 * An empty update key is a build that can verify nothing, and `updateChannel.ts`
 * refuses every update in that state rather than trusting the channel.
 */

declare const __FSS_API_BASE_URL__: string;
declare const __FSS_UPDATE_CHANNEL_URL__: string;
declare const __FSS_UPDATE_PUBLIC_KEY__: string;
declare const __FSS_APP_VERSION__: string;

const apiBaseUrl = __FSS_API_BASE_URL__;
const updateChannelUrl = __FSS_UPDATE_CHANNEL_URL__;
const updatePublicKey = __FSS_UPDATE_PUBLIC_KEY__;
const appVersion = __FSS_APP_VERSION__;

/**
 * The deep links this bundle answers to, as a closed set.
 *
 * Nothing from the URL becomes an argument, a path or a query: a link either is one
 * of these exact strings or it is ignored. That is what makes the scheme safe to
 * register at all — a `callie://` URL is something any web page can ask macOS to
 * open, so it must never be able to say anything the app acts on.
 */
export const DEEP_LINKS = Object.freeze(['callie://today']);

export function focusFor(url: string): boolean {
  if (!DEEP_LINKS.includes(url)) return false;
  const [window] = BrowserWindow.getAllWindows();
  if (window === undefined) return false;
  if (window.isMinimized()) window.restore();
  window.focus();
  return true;
}

// Before the app is ready, and therefore at module level.
protocol.registerSchemesAsPrivileged([{ scheme: BUNDLE_SCHEME, privileges: { ...BUNDLE_PRIVILEGES } }]);

function serveBundle(rendererDirectory: string): void {
  protocol.handle(BUNDLE_SCHEME, async request => {
    const answer = await answerBundleRequest(rendererDirectory, request.url);
    if (answer.status !== 200 || answer.body === undefined) return new Response(null, { status: answer.status });
    // The DOM's `BodyInit` does not name a bare Uint8Array; undici in the main
    // process takes one, and a copy of the bundle per request is not wanted.
    return new Response(answer.body as unknown as BodyInit, {
      headers: { 'content-type': answer.type ?? 'application/octet-stream' },
    });
  });
}

function main(): void {
  // One Callie per Mac. Without this, a deep link opens a second copy holding the
  // same device registration, and two copies renewing one refresh credential is
  // exactly the reuse that revokes the device (specification 5.3).
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', (_event, argv) => {
    for (const argument of argv) focusFor(argument);
  });
  // `open-url` has to be registered before the app is ready, or a link that
  // launched the app is delivered to nobody.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    focusFor(url);
  });

  const rendererDirectory = join(import.meta.dirname, '..', 'renderer');

  app
    .whenReady()
    .then(async () => {
      // The handler has to exist before the first window asks for a page, and
      // `protocol.handle` needs a ready app.
      serveBundle(rendererDirectory);
      const manager = await start({
        apiBaseUrl,
        clientVersion: appVersion,
        keychainService: 'com.callie.fss.desktop',
        userDataDirectory: join(app.getPath('userData'), 'callie'),
        rendererEntry: join(rendererDirectory, 'index.html'),
        rendererUrl: BUNDLE_ENTRY_URL,
        preloadEntry: join(import.meta.dirname, '..', 'preload', 'preload.cjs'),
      });
      // Lane g83: the update check runs now, at launch, as well as every six hours. It is
      // after `start` so that this build has opened its window — the start that lets an
      // updated build's predecessor be deleted — and it installs without asking.
      startUpdateWatch({
        currentVersion: appVersion,
        channelBaseUrl: updateChannelUrl,
        publicKey: updatePublicKey,
        blocked: async () => (await manager.state()).screen === 'upgrade_required',
      });
    })
    .catch((error: unknown) => {
      console.error(error);
      app.quit();
    });
}

main();
