import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How a packaged build serves its own interface.
 *
 * Not from `file://`. The `GrantFileProtocolExtraPrivileges` fuse is burned off
 * (`scripts/fuses.ts`), which is what stops a `file://` page from treating the rest
 * of the disk as same-origin — and in Electron 44 it also routes `file://` through
 * Chromium's plain loader, which knows nothing about asar archives, so a packaged
 * app whose window is opened with `loadFile` finds nothing at all. Turning the fuse
 * back on would trade a real privilege for a convenience; this is the other way out,
 * and it is the one the old client took as well.
 *
 * So the bundle gets its own scheme: standard, secure, and answering a closed set of
 * exact paths. `BUNDLE_FILES` is a map rather than a directory walk, so there is no
 * path to traverse and no name to smuggle — a request for anything not in it is a
 * 404 before any filesystem call happens. The renderer's `default-src 'none'`
 * Content-Security-Policy resolves `'self'` to this origin, which is why the shipped
 * pages need no change.
 *
 * ## Why the window list lives here rather than in the build script
 *
 * It used to be hand-written, and it listed three paths while the build shipped four
 * pages and four scripts. Every window except the first was a 404 in a packaged
 * build, and no test saw it because the development path uses `loadFile`. The list
 * is therefore one declaration per window, here, and three things read it: the
 * esbuild loop and the copy loop in `scripts/bundle.ts`, and the map below. A window
 * added in one place is added in all three, which is the only version of this that
 * stays true. See `docs/decisions/g9-bundle-scheme-map.md`.
 *
 * It lives in `src/main` rather than `scripts` because the scheme handler ships and
 * the build script does not: a shipped file may not import a build script, and the
 * dependency has to point this way.
 *
 * Nothing here imports Electron, so the answer is a unit test rather than a claim.
 */

export const BUNDLE_SCHEME = 'callie-app';
export const BUNDLE_ORIGIN = `${BUNDLE_SCHEME}://bundle`;
export const BUNDLE_ENTRY_URL = `${BUNDLE_ORIGIN}/index.html`;

/** Passed to `protocol.registerSchemesAsPrivileged` before the app is ready. */
export const BUNDLE_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  // The renderer talks to the main process across the bridge and to nothing else,
  // so it needs neither fetch nor CORS, and it never bypasses its own CSP.
  supportFetchAPI: false,
  corsEnabled: false,
  bypassCSP: false,
  allowServiceWorkers: false,
  stream: false,
});

/** One window: the page a `BrowserWindow` loads and the script that page loads. */
export interface BundleWindow {
  /** The HTML file, in `src/renderer` and at the root of the bundled renderer. */
  readonly page: string;
  /** The entry point: `src/renderer/{entry}.ts`, bundled to `{entry}.js`. */
  readonly entry: string;
  /** The lane that owns it, so a stale entry names somebody. */
  readonly ownedBy: string;
}

/**
 * Every window the application can open.
 *
 * The order is the order the windows arrived. G6's `today.html` is not here: lane g65
 * made Today the main window's Home, so `index.html` carries it
 * (`docs/decisions/g65-today-is-the-home.md`).
 */
export const BUNDLE_WINDOWS: readonly BundleWindow[] = Object.freeze([
  { page: 'index.html', entry: 'renderer', ownedBy: 'G2 identity, g65 Home' },
  { page: 'firmWorkspace.html', entry: 'firmWorkspace', ownedBy: 'G3b CRM' },
  { page: 'replyCard.html', entry: 'replyPage', ownedBy: 'G7b classifier' },
  { page: 'sequenceEditor.html', entry: 'sequenceEditor', ownedBy: 'G8 sequences' },
  { page: 'settings.html', entry: 'settingsPage', ownedBy: 'G9 administration' },
]);

/** Copied once and shared by every page. Not a window, so not in the list above. */
export const BUNDLE_SHARED_FILES: readonly string[] = Object.freeze(['styles.css']);

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
});

function typeOf(file: string): string {
  const extension = file.slice(file.lastIndexOf('.') + 1);
  const type = CONTENT_TYPES[extension];
  // A file whose extension nobody declared is not served as a guess: an unknown type
  // is a mistake in the list above, and the build should stop rather than ship a
  // page the browser sniffs.
  if (type === undefined) throw new Error(`no content type is declared for ${file}`);
  return type;
}

/**
 * Derived, never written twice. Every window contributes exactly two paths — its
 * page and its script — and the shared files contribute one each.
 */
export const BUNDLE_FILES: ReadonlyMap<string, { readonly file: string; readonly type: string }> =
  new Map(
    [
      ...BUNDLE_WINDOWS.flatMap(window => [window.page, `${window.entry}.js`]),
      ...BUNDLE_SHARED_FILES,
    ].map(file => [`/${file}`, { file, type: typeOf(file) }]),
  );

export interface BundleAnswer {
  readonly status: number;
  readonly type?: string;
  readonly body?: Uint8Array;
}

export async function answerBundleRequest(
  rendererDirectory: string,
  url: string,
  read: (path: string) => Promise<Uint8Array> = async path => await readFile(path),
): Promise<BundleAnswer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 400 };
  }
  if (`${parsed.protocol}//${parsed.host}` !== BUNDLE_ORIGIN) return { status: 404 };
  const entry = BUNDLE_FILES.get(parsed.pathname);
  if (entry === undefined) return { status: 404 };
  try {
    return { status: 200, type: entry.type, body: await read(join(rendererDirectory, entry.file)) };
  } catch {
    return { status: 404 };
  }
}
