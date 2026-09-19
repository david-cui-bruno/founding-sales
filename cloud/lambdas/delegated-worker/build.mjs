import { build } from 'esbuild';
// The three authenticated Lambda entries of the rebuilt core (slice S3), built from one source tree into one
// artifact: index.cjs is the API (handler unchanged), scheduler.cjs decides what is due, runner.cjs does the work.
// Terraform points three functions at the same zip with three different handlers and three different roles.
// Shared root modules are deliberately bundled, never resolved from an installed desktop app.
const noDesktopRuntime = { name: 'no-desktop-runtime', setup(build) {
  build.onResolve({ filter: /(?:electron|better-sqlite3|sqlcipher|safeStorage)/ }, args => {
    throw new Error(`Forbidden worker dependency: ${args.path}`);
  });
} };
for (const [entry, outfile] of [['src/api.ts', 'dist/index.cjs'], ['src/scheduler.ts', 'dist/scheduler.cjs'], ['src/runner.ts', 'dist/runner.cjs']]) {
  await build({ entryPoints: [entry], bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    outfile, metafile: true, plugins: [noDesktopRuntime], logLevel: 'info' });
}
