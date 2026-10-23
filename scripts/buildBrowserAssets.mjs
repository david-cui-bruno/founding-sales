import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildBrowserAssets } from '../apps/web/src/server/assets.ts';
import { loadBrowserAssets } from '../apps/web/src/server/publicAssets.ts';

const directory = resolve(process.argv[2] ?? 'browser-public');
const assets = await buildBrowserAssets();
await mkdir(directory, { recursive: true });
for (const [route, filename] of [['/', 'index.html'], ['/renderer.js', 'renderer.js'], ['/styles.css', 'styles.css']]) {
  const asset = assets.get(route);
  if (!asset) throw new Error('Invalid browser public asset output');
  await writeFile(resolve(directory, filename), asset.body, { flag: 'wx', mode: 0o644 });
}
await loadBrowserAssets(directory);
