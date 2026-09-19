import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the main, preload and renderer bundles into `.vite/` without packaging, for the Playwright specs
 * and for a quick local run (`npx electron .`). The three Vite configurations are resolved through the
 * Forge Vite plugin's own generator, so the layout and the `MAIN_WINDOW_VITE_*` defines are exactly what
 * `electron-forge package` produces; only the packaging steps (ASAR, fuses, signing, helper) are skipped.
 */
process.env.VITE_CJS_IGNORE_WARNING = 'true';
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { build } = require('vite');
const generatorModule = require('@electron-forge/plugin-vite/dist/ViteConfig.js');
const ViteConfigGenerator = generatorModule.default ?? generatorModule;

// The same plugin configuration as `forge.config.ts`; keep both lists identical.
const pluginConfig = {
  build: [
    { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
    { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
  ],
  renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
};

export async function buildClient({ root = clientRoot } = {}) {
  const generator = new ViteConfigGenerator(pluginConfig, root, true);
  rmSync(join(root, '.vite'), { recursive: true, force: true });
  for (const config of await generator.getBuildConfigs()) {
    await build({ configFile: false, logLevel: 'error', ...config });
  }
  for (const config of await generator.getRendererConfig()) {
    await build({ configFile: false, logLevel: 'error', ...config });
  }
  return join(root, '.vite');
}

// No top-level await: the Playwright global setup may load this module through require().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildClient().then(
    (output) => { process.stdout.write(`Built client bundles under ${output}\n`); },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
