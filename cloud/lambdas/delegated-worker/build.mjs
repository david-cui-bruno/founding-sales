import { build } from 'esbuild';
// Actual authenticated Lambda entry. Shared root modules
// are deliberately bundled, never resolved from an installed desktop app.
await build({ entryPoints: ['src/handler.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  outfile: 'dist/index.cjs', metafile: true, plugins: [{ name: 'no-desktop-runtime', setup(build) {
    build.onResolve({ filter: /(?:electron|better-sqlite3|sqlcipher|safeStorage)/ }, args => {
      throw new Error(`Forbidden worker dependency: ${args.path}`);
    });
  } }], logLevel: 'info' });
