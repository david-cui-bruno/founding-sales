import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  answerBundleRequest,
  BUNDLE_ENTRY_URL,
  BUNDLE_ORIGIN,
  BUNDLE_PRIVILEGES,
  BUNDLE_SHARED_FILES,
  BUNDLE_WINDOWS,
} from '../../src/main/bundleScheme.ts';
import { handlersForScheme } from '../../src/main/launchServices.ts';

/**
 * Two small surfaces a packaged build has and a development one does not: the scheme
 * the interface is served over, and the question "does this Mac know how to place a
 * call".
 */

const rendererDirectory = '/Applications/Callie.app/Contents/Resources/app.asar/renderer';

async function answer(url: string): Promise<{ status: number; read: string[] }> {
  const read: string[] = [];
  const outcome = await answerBundleRequest(rendererDirectory, url, async path => {
    read.push(path);
    return await Promise.resolve(new TextEncoder().encode('contents'));
  });
  return { status: outcome.status, read };
}

describe('the bundle scheme answers every window and refuses everything else', () => {
  it('serves the entry page the window is opened with', async () => {
    const outcome = await answer(BUNDLE_ENTRY_URL);
    expect(outcome.status).toBe(200);
    expect(outcome.read).toEqual([`${rendererDirectory}/index.html`]);
  });

  it('serves the script and the stylesheet the page asks for', async () => {
    await expect(answer(`${BUNDLE_ORIGIN}/renderer.js`)).resolves.toMatchObject({ status: 200 });
    await expect(answer(`${BUNDLE_ORIGIN}/styles.css`)).resolves.toMatchObject({ status: 200 });
  });

  it('never touches the filesystem for a name it does not already know', async () => {
    for (const path of [
      '/../../../../etc/passwd',
      '/index.html%2F..%2Fpackage.json',
      '/release-stamp.json',
      '/main/main.js',
      '/',
      '/index.html/',
    ]) {
      const outcome = await answer(`${BUNDLE_ORIGIN}${path}`);
      expect(outcome.status, path).toBe(404);
      expect(outcome.read, path).toEqual([]);
    }
  });

  it('refuses another host on the same scheme', async () => {
    await expect(answer('callie-app://elsewhere/index.html')).resolves.toEqual({ status: 404, read: [] });
  });

  it('refuses another scheme entirely', async () => {
    await expect(answer('https://bundle/index.html')).resolves.toEqual({ status: 404, read: [] });
    await expect(answer('file:///index.html')).resolves.toEqual({ status: 404, read: [] });
  });

  it('answers 404, not 500, when the file really is missing', async () => {
    const outcome = await answerBundleRequest(rendererDirectory, BUNDLE_ENTRY_URL, async () => {
      await Promise.resolve();
      throw new Error('ENOENT');
    });
    expect(outcome.status).toBe(404);
  });

  /**
   * The test the old hand-written map did not have.
   *
   * `BUNDLE_FILES` listed three paths while the build shipped five pages and five
   * scripts, so every window but the first was a 404 in a packaged build. Nothing
   * caught it because the development path opens windows with `loadFile`, which
   * never reaches the scheme handler at all.
   *
   * So: every declared window's page and script must resolve, and each page's one
   * module script must be the entry that window declares. A window added to
   * `BUNDLE_WINDOWS` with a typo in either name fails here rather than in somebody's
   * packaged build.
   */
  it('serves the page and the script of every declared window', async () => {
    expect(BUNDLE_WINDOWS.length).toBeGreaterThan(1);
    for (const window of BUNDLE_WINDOWS) {
      await expect(answer(`${BUNDLE_ORIGIN}/${window.page}`), window.page).resolves.toMatchObject({
        status: 200,
      });
      await expect(answer(`${BUNDLE_ORIGIN}/${window.entry}.js`), window.entry).resolves.toMatchObject({
        status: 200,
      });
    }
    for (const file of BUNDLE_SHARED_FILES) {
      await expect(answer(`${BUNDLE_ORIGIN}/${file}`), file).resolves.toMatchObject({ status: 200 });
    }
  });

  it('declares, for every window, the entry its page actually loads', async () => {
    const directory = fileURLToPath(new URL('../../src/renderer/', import.meta.url));
    for (const window of BUNDLE_WINDOWS) {
      const html = await readFile(`${directory}${window.page}`, 'utf8');
      const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gu)].map(match => match[1]);
      // One script per page, because the CSP is `script-src 'self'` with no inline
      // script and a second file would be a second thing to keep in the map.
      expect(scripts, window.page).toEqual([`./${window.entry}.js`]);
    }
  });

  it('is standard and secure, and grants nothing else', () => {
    expect({ ...BUNDLE_PRIVILEGES }).toEqual({
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      bypassCSP: false,
      allowServiceWorkers: false,
      stream: false,
    });
  });
});

/**
 * A slice of a real `lsregister -dump` from this Mac, with the identifiers changed.
 * The shape is what matters: records separated by rules, `identifier:` naming the
 * bundle, `claimed schemes:` listing what it says it can open, and separate claim
 * records whose `bindings:` lines name the bundle by display name rather than by id.
 */
const dump = `--------------------------------------------------------------------------------
bundle id:                  Phone (0x48c)
path:                       /System/Applications/Phone.app (0x1354)
identifier:                 test.mobilephone
claimed schemes:            facetime-audio:, phoneapp:, tel:, telephony:
--------------------------------------------------------------------------------
claim id:                   Telephony URL (0xd28)
bundle:                     Phone (0x48c)
bindings:                   tel:, telephony:, facetime-audio:
--------------------------------------------------------------------------------
bundle id:                  Callie (0xcff0)
path:                       /Applications/Callie.app (0x4)
identifier:                 com.callie.fss.desktop
claimed schemes:            callie:
--------------------------------------------------------------------------------
bundle id:                  Notes (0x111)
identifier:                 test.notes
--------------------------------------------------------------------------------
`;

describe('the tel: local-setup check reads Launch Services rather than trying a call', () => {
  it('finds every bundle claiming a scheme, by identifier', () => {
    expect(handlersForScheme(dump, 'tel')).toEqual(['test.mobilephone']);
    expect(handlersForScheme(dump, 'callie')).toEqual(['com.callie.fss.desktop']);
  });

  it('does not match a scheme that is only a prefix of a claimed one', () => {
    expect(handlersForScheme(dump, 'te')).toEqual([]);
    expect(handlersForScheme(dump, 'telephon')).toEqual([]);
  });

  it('reports nothing for a scheme no bundle claims', () => {
    expect(handlersForScheme(dump, 'sms')).toEqual([]);
  });

  it('is empty rather than wrong when the database could not be read', () => {
    expect(handlersForScheme('', 'tel')).toEqual([]);
  });
});
