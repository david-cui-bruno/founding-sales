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
 * So the bundle gets its own scheme: standard, secure, and answering three exact
 * paths. `BUNDLE_FILES` is a closed map, so there is no path to traverse and no name
 * to smuggle — a request for anything not in it is a 404 before any filesystem call
 * happens. The renderer's `default-src 'none'` Content-Security-Policy resolves
 * `'self'` to this origin, which is why the shipped `index.html` needs no change.
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

const BUNDLE_FILES = new Map<string, { readonly file: string; readonly type: string }>([
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/renderer.js', { file: 'renderer.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

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
