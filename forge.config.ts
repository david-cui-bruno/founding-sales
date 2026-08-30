import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import {
  applyElectronFuses,
  resetPackagedAdHocSignature,
} from './build/electronFuses';

const hasConfiguredMacSigning = (value: unknown): boolean =>
  (typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length > 0) ||
  Boolean(value);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
      },
    },
    ignore: (filePath: string) => {
      if (filePath.length === 0) {
        return false;
      }

      return !(
        filePath.startsWith('/.vite') ||
        filePath === '/node_modules' ||
        filePath.startsWith('/node_modules/better-sqlite3')
      );
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  hooks: {
    packageAfterCopy: async (
      resolvedConfig,
      buildPath,
      _electronVersion,
      platform,
      arch,
    ) => {
      await applyElectronFuses(
        buildPath,
        platform,
        arch,
        hasConfiguredMacSigning(resolvedConfig.packagerConfig.osxSign),
      );
    },
    postPackage: async (resolvedConfig, packageResult) => {
      await resetPackagedAdHocSignature(
        packageResult.outputPaths,
        packageResult.platform,
        packageResult.arch,
        hasConfiguredMacSigning(resolvedConfig.packagerConfig.osxSign),
      );
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
