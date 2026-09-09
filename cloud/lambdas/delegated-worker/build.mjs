import { build } from 'esbuild';
// Library only. C2 owns the future authenticated handler. Shared root modules
// are deliberately bundled, never resolved from an installed desktop app.
await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  outfile: 'dist/index.cjs', metafile: true, plugins: [{ name: 'no-desktop-runtime', setup(build) {
    build.onResolve({ filter: /(?:electron|better-sqlite3|sqlcipher|safeStorage)/ }, args => {
      throw new Error(`Forbidden worker dependency: ${args.path}`);
    });
  } }], logLevel: 'info' });
