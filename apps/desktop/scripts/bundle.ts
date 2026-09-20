import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { RELEASE_STAMP_FILE, type ReleaseStamp } from './releaseStamp.ts';

/**
 * The application directory a packager turns into a bundle.
 *
 * Everything the app runs is bundled here, so the packaged tree contains no
 * `node_modules` at all: nothing to prune, nothing to audit inside the asar, and no
 * way for a development dependency to arrive in a release because somebody hoisted
 * it. Electron itself stays external, because it is the runtime rather than a
 * dependency.
 *
 * The four `define` values are the entire build-time configuration. They are public
 * — two hostnames, a version, and the public half of the update-signing key — and
 * `scripts/verifyPackage.ts` reads the key back out of the packed JavaScript, so
 * "embedded at build time" is a property somebody can check rather than a claim in
 * a build log.
 */

export const APP_PRODUCT_NAME = 'Callie';
export const APP_BUNDLE_ID = 'com.callie.fss.desktop';
export const APP_URL_SCHEME = 'callie';

export interface BundleInput {
  /** `apps/desktop`. */
  readonly root: string;
  /** Where the application directory is written. Emptied by the caller. */
  readonly stagingDirectory: string;
  readonly apiBaseUrl: string;
  readonly updateChannelUrl: string;
  readonly stamp: ReleaseStamp;
}

export async function bundleApp(input: BundleInput): Promise<void> {
  const source = (...parts: string[]): string => join(input.root, 'src', ...parts);
  const target = (...parts: string[]): string => join(input.stagingDirectory, ...parts);

  await mkdir(target('main'), { recursive: true });
  await mkdir(target('preload'), { recursive: true });
  await mkdir(target('renderer'), { recursive: true });

  const define = {
    __FSS_API_BASE_URL__: JSON.stringify(input.apiBaseUrl),
    __FSS_UPDATE_CHANNEL_URL__: JSON.stringify(input.updateChannelUrl),
    __FSS_UPDATE_PUBLIC_KEY__: JSON.stringify(input.stamp.updatePublicKey),
    __FSS_APP_VERSION__: JSON.stringify(input.stamp.appVersion),
  };

  await build({
    entryPoints: [source('main', 'main.ts')],
    outfile: target('main', 'main.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    // ESM, because `main.ts` locates the renderer through `import.meta.dirname`.
    format: 'esm',
    external: ['electron'],
    define,
    sourcemap: false,
    minify: false,
    logLevel: 'silent',
  });

  await build({
    entryPoints: [source('preload', 'preload.ts')],
    // CommonJS and a `.cjs` name: a sandboxed preload script is not an ES module,
    // and the application package.json says `"type": "module"`.
    outfile: target('preload', 'preload.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'silent',
  });

  // Three renderer entry points, one per window: G2's sign-in page, G3b's CRM
  // windows and this lane's Today page. Each is bundled separately rather than code
  // split, because a window loads one script and nothing else — and because the CSP
  // on every page is `script-src 'self'` with no inline script, so a shared chunk
  // would only be a second file to get wrong.
  for (const entry of ['renderer', 'firmWorkspace', 'todayPage'] as const) {
    await build({
      entryPoints: [source('renderer', `${entry}.ts`)],
      outfile: target('renderer', `${entry}.js`),
      bundle: true,
      platform: 'browser',
      target: 'es2023',
      format: 'esm',
      sourcemap: false,
      logLevel: 'silent',
    });
  }

  for (const page of ['index.html', 'firmWorkspace.html', 'today.html', 'styles.css'] as const) {
    await copyFile(source('renderer', page), target('renderer', page));
  }

  await writeFile(
    target('package.json'),
    `${JSON.stringify(
      {
        name: 'callie',
        productName: APP_PRODUCT_NAME,
        version: input.stamp.appVersion,
        private: true,
        type: 'module',
        main: 'main/main.js',
      },
      null,
      2,
    )}\n`,
  );

  // Inside the asar, therefore inside the signature: editing the stamp after the
  // build breaks `codesign --verify`.
  await writeFile(target(RELEASE_STAMP_FILE), `${JSON.stringify(input.stamp, null, 2)}\n`);
}
