import { fileURLToPath } from 'node:url';
import { build, context, type BuildOptions, type Metafile, type OutputFile } from 'esbuild';
import type { BrowserAssets } from './hostContract.ts';

const index = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Callie</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>';

/** Builds only the existing browser presentation. No runtime settings enter esbuild. */
export async function buildBrowserAssets(): Promise<BrowserAssets> {
  return (await buildBrowserAssetOutput()).assets;
}

/** Build-only seam: private maps never enter the HTTP asset map. */
export async function buildBrowserAssetOutput(privateSourceMaps = false) {
  return projectBrowserAssetOutput(await build(browserAssetBuildOptions(privateSourceMaps)), privateSourceMaps);
}

/** Single esbuild convention shared by one-shot production builds and the local rebuilder. */
function browserAssetBuildOptions(privateSourceMaps: boolean): BuildOptions & { write: false; metafile: true } {
  return {
    absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    entryPoints: [fileURLToPath(new URL('../client/main.tsx', import.meta.url))],
    outdir: 'browser-public-build', entryNames: 'renderer',
    bundle: true, write: false, format: 'esm', platform: 'browser',
    target: 'es2022', jsx: 'automatic', minify: true,
    sourcemap: privateSourceMaps ? 'external' : false, sourcesContent: true, legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true,
  };
}

function projectBrowserAssetOutput(result: { readonly metafile: Metafile; readonly outputFiles: readonly OutputFile[] }, privateSourceMaps: boolean) {
  // Fail closed if a future UI import pulls server, native or environment code
  // into public output. This is a dependency boundary, not secret-value scanning.
  for (const input of Object.keys(result.metafile.inputs)) {
    if (/(?:^|\/)(?:server|electron|\.env(?:\.[^/]*)?)(?:\/|$)/u.test(input)) {
      throw new Error('Invalid browser public asset dependency');
    }
  }
  const script = result.outputFiles.find(file => file.path.endsWith('/renderer.js'));
  const styles = result.outputFiles.find(file => file.path.endsWith('/renderer.css'));
  const maps = result.outputFiles.filter(file => file.path.endsWith('.map'));
  if (result.outputFiles.length !== (privateSourceMaps ? 4 : 2) || !script || !styles || !script.contents.length || !styles.contents.length) {
    throw new Error('Invalid browser public asset output');
  }
  const assets: BrowserAssets = new Map([
    ['/', { body: new TextEncoder().encode(index), contentType: 'text/html; charset=utf-8' }],
    ['/renderer.js', { body: script.contents, contentType: 'text/javascript; charset=utf-8' }],
    ['/styles.css', { body: styles.contents, contentType: 'text/css; charset=utf-8' }],
  ]);
  return { assets, maps };
}

/** Local-only incremental builder over the same public build options and dependency
 * boundary. It holds an esbuild context but never watches files: each rebuild is an
 * explicit caller request. A failed rebuild rejects and publishes nothing. */
export interface BrowserAssetRebuilder {
  rebuild(): Promise<BrowserAssets>;
  dispose(): Promise<void>;
}

export async function createBrowserAssetRebuilder(): Promise<BrowserAssetRebuilder> {
  const builder = await context(browserAssetBuildOptions(false));
  let tail: Promise<unknown> = Promise.resolve();
  let disposed: Promise<void> | undefined;
  return {
    rebuild: () => {
      if (disposed) return Promise.reject(new Error('Browser asset rebuilder disposed'));
      const run = tail.then(async () => {
        if (disposed) throw new Error('Browser asset rebuilder disposed');
        return projectBrowserAssetOutput(await builder.rebuild(), false).assets;
      });
      tail = run.catch(() => undefined);
      return run;
    },
    dispose: () => disposed ??= tail.then(() => builder.dispose()),
  };
}
