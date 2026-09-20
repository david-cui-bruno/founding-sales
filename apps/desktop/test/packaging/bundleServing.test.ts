import { describe, expect, it } from 'vitest';
import { BUNDLE_SHARED_FILES, BUNDLE_WINDOWS } from '../../src/main/bundleScheme.ts';
import { checkBundleServing, type PackagedRenderer } from '../../scripts/verifyPackage.ts';

/**
 * G13b deliverable 3: every window loads from the packaged bundle.
 *
 * G9 derived `BUNDLE_FILES` from `BUNDLE_WINDOWS`, which makes "a declared window is
 * in the map" structurally true — and leaves the two questions a derivation cannot
 * answer, both of which are about the *artifact* rather than about the source:
 *
 *   1. the file a declared window names is actually inside the asar;
 *   2. nothing is inside the asar that the closed map will not serve.
 *
 * The second is the shape of the bug G9 fixed: the build shipped a page per window
 * while the map named three paths, so five windows were a 404 in a packaged build and
 * nothing saw it, because development opens windows with `loadFile` and never reaches
 * the scheme handler.
 *
 * `checkBundleServing` takes the archive as a pair of functions, so these run in the
 * ordinary gate against a fabricated bundle and the host layer runs the same code
 * against a real one (`test/host/package.host.test.ts`).
 */

/** Everything a correct build puts in the renderer directory. */
function completeBundle(): Map<string, string> {
  const files = new Map<string, string>();
  for (const window of BUNDLE_WINDOWS) {
    files.set(window.page, `<!doctype html><script type="module" src="./${window.entry}.js"></script>`);
    files.set(`${window.entry}.js`, `// ${window.entry}`);
  }
  for (const shared of BUNDLE_SHARED_FILES) files.set(shared, '/* shared */');
  return files;
}

function rendererOf(files: ReadonlyMap<string, string>): PackagedRenderer {
  return {
    list: () => [...files.keys()],
    read: async name => {
      const body = files.get(name);
      if (body === undefined) throw new Error(`ENOENT ${name}`);
      return await Promise.resolve(new TextEncoder().encode(body));
    },
  };
}

describe('the packaged bundle serves every declared window', () => {
  it('accepts a bundle holding exactly what the windows declare', async () => {
    const report = await checkBundleServing(rendererOf(completeBundle()));

    expect(report.unserved).toEqual([]);
    expect(report.windows).toHaveLength(BUNDLE_WINDOWS.length);
    for (const window of report.windows) {
      expect(window.pageStatus, window.page).toBe(200);
      expect(window.scriptStatus, window.entry).toBe(200);
      expect(window.declaredEntryLoaded, window.page).toBe(true);
      expect(
        window.pageScripts.map(script => script.status),
        window.page,
      ).toEqual([200]);
    }
    expect(report.ok).toBe(true);
  });

  it('refuses a bundle whose page is missing, rather than reporting a 404 as a detail', async () => {
    const files = completeBundle();
    const [missing] = BUNDLE_WINDOWS;
    if (missing === undefined) throw new Error('no windows are declared');
    files.delete(missing.page);

    const report = await checkBundleServing(rendererOf(files));

    expect(report.ok).toBe(false);
    expect(report.windows.find(window => window.page === missing.page)?.pageStatus).toBe(404);
  });

  it('refuses a bundle whose script is missing', async () => {
    const files = completeBundle();
    const last = BUNDLE_WINDOWS[BUNDLE_WINDOWS.length - 1];
    if (last === undefined) throw new Error('no windows are declared');
    files.delete(`${last.entry}.js`);

    const report = await checkBundleServing(rendererOf(files));

    expect(report.ok).toBe(false);
    const window = report.windows.find(candidate => candidate.entry === last.entry);
    expect(window?.scriptStatus).toBe(404);
    // The page still loads; the script tag on it is the 404, which is exactly what a
    // person would see as a blank window.
    expect(window?.pageStatus).toBe(200);
    expect(window?.pageScripts.map(script => script.status)).toEqual([404]);
  });

  it('refuses a page whose script tag names a file the map will not serve', async () => {
    const files = completeBundle();
    const [first] = BUNDLE_WINDOWS;
    if (first === undefined) throw new Error('no windows are declared');
    files.set(first.page, '<!doctype html><script type="module" src="./notAWindow.js"></script>');

    const report = await checkBundleServing(rendererOf(files));

    expect(report.ok).toBe(false);
    const window = report.windows.find(candidate => candidate.page === first.page);
    expect(window?.declaredEntryLoaded).toBe(false);
    expect(window?.pageScripts).toEqual([{ src: './notAWindow.js', status: 404 }]);
  });

  it('refuses a page that loads no script at all', async () => {
    const files = completeBundle();
    const [first] = BUNDLE_WINDOWS;
    if (first === undefined) throw new Error('no windows are declared');
    files.set(first.page, '<!doctype html><p>nothing runs here</p>');

    const report = await checkBundleServing(rendererOf(files));

    expect(report.ok).toBe(false);
    expect(report.windows.find(window => window.page === first.page)?.pageScripts).toEqual([]);
  });

  /**
   * The G9 bug, from the artifact's side: a file the build shipped that the closed
   * map does not answer is a window nobody can open, and it is invisible to a check
   * that only walks the declaration.
   */
  it('names a packaged file the scheme will not serve', async () => {
    const files = completeBundle();
    files.set('orphan.html', '<!doctype html>');

    const report = await checkBundleServing(rendererOf(files));

    expect(report.ok).toBe(false);
    expect(report.unserved).toEqual(['orphan.html']);
  });
});
