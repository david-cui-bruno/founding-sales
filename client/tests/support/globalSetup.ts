import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/**
 * Builds the main, preload and renderer bundles once per Playwright run, through the same script a
 * developer uses (`npm run build`), so the specs launch exactly what that script produces.
 */
export default function globalSetup(): void {
  const clientRoot = resolve(__dirname, '..', '..');
  const result = spawnSync(process.execPath, [join(clientRoot, 'scripts', 'buildClient.mjs')], {
    cwd: clientRoot,
    stdio: 'inherit',
    timeout: 300_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`client build failed${result.error ? `: ${result.error.message}` : ` with status ${result.status}`}`);
  }
}
