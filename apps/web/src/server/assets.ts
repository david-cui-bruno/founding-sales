import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { BrowserAssets } from './hostContract.ts';

const index = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Callie</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>';

/** Builds only the existing browser presentation. No runtime settings enter esbuild. */
export async function buildBrowserAssets(): Promise<BrowserAssets> {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    entryPoints: [fileURLToPath(new URL('../client/main.tsx', import.meta.url))],
    outdir: 'browser-public-build', entryNames: 'renderer',
    bundle: true, write: false, format: 'esm', platform: 'browser',
    target: 'es2022', jsx: 'automatic', minify: true,
    sourcemap: false, legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true,
  });
  // Fail closed if a future UI import pulls server, native or environment code
  // into public output. This is a dependency boundary, not secret-value scanning.
  for (const input of Object.keys(result.metafile.inputs)) {
    if (/(?:^|\/)(?:server|electron|\.env(?:\.[^/]*)?)(?:\/|$)/u.test(input)) {
      throw new Error('Invalid browser public asset dependency');
    }
  }
  const script = result.outputFiles.find(file => file.path.endsWith('/renderer.js'));
  const styles = result.outputFiles.find(file => file.path.endsWith('/renderer.css'));
  if (result.outputFiles.length !== 2 || !script || !styles || !script.contents.length || !styles.contents.length) {
    throw new Error('Invalid browser public asset output');
  }
  return new Map([
    ['/', { body: new TextEncoder().encode(index), contentType: 'text/html; charset=utf-8' }],
    ['/renderer.js', { body: script.contents, contentType: 'text/javascript; charset=utf-8' }],
    ['/styles.css', { body: styles.contents, contentType: 'text/css; charset=utf-8' }],
  ]);
}
