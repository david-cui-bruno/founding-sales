import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { BrowserAssets, BrowserStaticAsset } from './hostContract.ts';

const files = [
  ['index.html', '/', 'text/html; charset=utf-8', 64 * 1024],
  ['renderer.js', '/renderer.js', 'text/javascript; charset=utf-8', 8 * 1024 * 1024],
  ['styles.css', '/styles.css', 'text/css; charset=utf-8', 1024 * 1024],
] as const;

/** Startup-only loader. Request paths never enter filesystem operations. */
export async function loadBrowserAssets(directory: string): Promise<BrowserAssets> {
  try {
    if (!isAbsolute(directory) || directory.includes('\0') || resolve(directory) !== directory) throw new Error();
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(directory) !== directory) throw new Error();
    const assets = new Map<string, BrowserStaticAsset>();
    for (const [filename, route, contentType, maximum] of files) {
      const handle = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error();
        // A bounded read also refuses files that grow after the size check.
        const buffer = Buffer.alloc(maximum + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size < 1 || size > maximum) throw new Error();
        assets.set(route, { contentType, body: buffer.subarray(0, size) });
      } finally {
        await handle.close();
      }
    }
    return assets;
  } catch {
    throw new Error('Invalid browser public assets');
  }
}
