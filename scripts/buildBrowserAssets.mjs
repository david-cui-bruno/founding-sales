import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildBrowserAssetOutput } from '../apps/web/src/server/assets.ts';
import { loadBrowserAssets } from '../apps/web/src/server/publicAssets.ts';

const directory = resolve(process.argv[2] ?? 'browser-public');
const privateDirectory = process.argv[3] ? resolve(process.argv[3]) : undefined;
if (privateDirectory === directory) throw new Error('Private source maps require a separate directory');
const { assets, maps } = await buildBrowserAssetOutput(Boolean(privateDirectory));
if (privateDirectory) {
  await mkdir(privateDirectory, { recursive: true });
  await writeFile(resolve(privateDirectory, 'renderer.js'), assets.get('/renderer.js').body, { flag: 'wx' });
  for (const map of maps) {
    // CSS is public under styles.css, but only JavaScript needs error symbolication.
    if (basename(map.path) === 'renderer.js.map') {
      await writeFile(resolve(privateDirectory, 'renderer.js.map'), map.contents, { flag: 'wx' });
    }
  }
  // Injection happens BEFORE the public copy: uploaded and deployed bytes are identical.
  // CLI handles esbuild output without the bundler plugin's splitting limitation.
  execFileSync(resolve('node_modules/.bin/sentry-cli'), ['sourcemaps', 'inject', privateDirectory], {
    stdio: 'pipe', env: { PATH: process.env.PATH, SENTRY_LOG_LEVEL: 'error', SENTRY_DISABLE_UPDATE_CHECK: '1' },
  });
}
await mkdir(directory, { recursive: true });
for (const [route, filename] of [['/', 'index.html'], ['/renderer.js', 'renderer.js'], ['/styles.css', 'styles.css']]) {
  const asset = assets.get(route);
  if (!asset) throw new Error('Invalid browser public asset output');
  const body = privateDirectory && filename === 'renderer.js'
    ? await readFile(resolve(privateDirectory, filename)) : asset.body;
  await writeFile(resolve(directory, filename), body, { flag: 'wx', mode: 0o644 });
}
await loadBrowserAssets(directory);
