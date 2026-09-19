import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { resolve } from 'node:path';
import {
  createAppleBridgeForgeHooks,
  createAppleBridgeSigningOptions,
} from '../build/appleBridge';
import { resolveMacSigningIdentity } from '../build/signingIdentity';
import { createReleaseAssembly } from '../scripts/writeReleaseMarker.mjs';

/**
 * The thin client's own Forge configuration (FSS target design, section 7). It is a separate package with
 * its own output directory, but the fuses, code signing and the Apple bridge helper come from the same
 * root modules the old app uses, so the helper lands at `Contents/Helpers/Callie Apple Bridge.app` here too.
 * There is no native module, no SQLite and no ASAR unpack directory. The root configuration has no
 * notarization step, so there is none to copy here either.
 */
const repositoryRoot = resolve(__dirname, '..');
const releaseAssembly = createReleaseAssembly({ root: __dirname });
const appleBridgeHooks = createAppleBridgeForgeHooks({ projectRoot: repositoryRoot });

const signingIdentity = resolveMacSigningIdentity({
  env: process.env,
  platform: process.platform,
});
const rootSigning = createAppleBridgeSigningOptions(signingIdentity);
// The root helper names the helper entitlements relative to the repository root; Forge runs from `client/` here.
const osxSign =
  rootSigning === undefined
    ? undefined
    : {
        ...rootSigning,
        optionsForFile: (filePath: string) => {
          const options: { entitlements?: string } = rootSigning.optionsForFile(filePath);
          return options.entitlements === undefined
            ? options
            : { ...options, entitlements: resolve(repositoryRoot, options.entitlements) };
        },
      };

const config: ForgeConfig = {
  outDir: resolve(__dirname, 'out'),
  packagerConfig: {
    appBundleId: 'com.callie.client',
    asar: true,
    icon: resolve(repositoryRoot, 'assets/icon'),
    osxSign,
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
      },
    },
    // Only the Vite output ships; the Vite plugin writes a trimmed package.json into the bundle itself.
    ignore: (filePath: string) => (filePath.length === 0 ? false : !filePath.startsWith('/.vite')),
    afterCopy: [(buildPath, _electronVersion, _platform, _arch, callback) => {
      try {
        releaseAssembly.copy(buildPath);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }],
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['darwin'])],
  hooks: {
    ...appleBridgeHooks,
    prePackage: async () => { releaseAssembly.begin(); },
    postPackage: async (resolvedConfig, packageResult) => {
      await appleBridgeHooks.postPackage?.(resolvedConfig, packageResult);
      releaseAssembly.finish();
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
};

export default config;
