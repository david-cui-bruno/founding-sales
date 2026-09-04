import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import {
  createAppleBridgeForgeHooks,
  createAppleBridgeSigningOptions,
} from './build/appleBridge';
import { retainOnlyPackagedEncryptedSqliteRuntime } from './scripts/packageEncryptedSqliteNative.mjs';
import { resolveMacSigningIdentity } from './build/signingIdentity';

const signingIdentity = resolveMacSigningIdentity({
  env: process.env,
  platform: process.platform,
});

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: 'com.callie.foundersales',
    asar: {
      unpack: '**/*.node',
      unpackDir: '.vite/build',
    },
    icon: './assets/icon',
    osxSign: createAppleBridgeSigningOptions(signingIdentity),
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
        filePath === '/native/safe-log-fs/build/Release/safe_log_fs.node' ||
        filePath === '/node_modules' ||
        filePath.startsWith('/node_modules/better-sqlite3-multiple-ciphers')
      );
    },
    afterCopy: [(
      buildPath,
      _electronVersion,
      platform,
      arch,
      callback,
    ) => {
      retainOnlyPackagedEncryptedSqliteRuntime({ buildPath, platform, arch })
        .then(() => callback(), callback);
    }],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  hooks: createAppleBridgeForgeHooks({ projectRoot: __dirname }),
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
