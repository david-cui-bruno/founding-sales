// TypeScript's legacy resolver needs the tsconfig path mapping for this
// exports-only package; Node >=22.12 resolves the runtime ESM entrypoint.
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import {
  flipFuses,
  FuseV1Options,
  FuseVersion,
  type FuseConfig,
} from '@electron/fuses'; // eslint-disable-line import/no-unresolved
import { resolve } from 'node:path';
import { promisify } from 'node:util';

export const electron44FuseConfig = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // Electron 44's stock arm64 bundle has no browser_v8_context_snapshot file;
  // enabling this fuse makes that supported runtime terminate with SIGTRAP.
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // Callie serves bundled UI through callie:// and never needs file://'s
  // legacy universal-access privileges.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  // Keep V8's supported arm64 guard-page trap handling for WebAssembly.
  [FuseV1Options.WasmTrapHandlers]: true,
} satisfies FuseConfig;

type FuseFlipper = (
  executablePath: string,
  config: FuseConfig,
) => Promise<unknown>;

type CommandRunner = (
  command: string,
  args: string[],
) => Promise<unknown>;

const execFileAsync = promisify(execFile);

const defaultCommandRunner: CommandRunner = async (command, args) => {
  await execFileAsync(command, args);
};

const extractedElectronExecutable = (
  buildPath: string,
  platform: string,
): string => {
  const applicationRoot = resolve(buildPath, '../..');

  if (platform === 'darwin' || platform === 'mas') {
    return resolve(applicationRoot, 'MacOS', 'Electron');
  }

  return resolve(
    applicationRoot,
    platform === 'win32' ? 'electron.exe' : 'electron',
  );
};

export const applyElectronFuses = async (
  buildPath: string,
  platform: string,
  arch: string,
  hasConfiguredMacSigning: boolean,
  flip: FuseFlipper = flipFuses,
): Promise<void> => {
  await flip(extractedElectronExecutable(buildPath, platform), {
    ...electron44FuseConfig,
    resetAdHocDarwinSignature:
      !hasConfiguredMacSigning &&
      (platform === 'darwin' || platform === 'mas') &&
      arch === 'arm64',
  });
};

export const resetPackagedAdHocSignature = async (
  outputPaths: string[],
  platform: string,
  arch: string,
  hasConfiguredMacSigning: boolean,
  runCommand: CommandRunner = defaultCommandRunner,
): Promise<void> => {
  if (
    hasConfiguredMacSigning ||
    platform !== 'darwin' ||
    arch !== 'arm64'
  ) {
    return;
  }

  const appPaths = outputPaths.flatMap((outputPath) => {
    if (outputPath.endsWith('.app')) {
      return [outputPath];
    }

    return readdirSync(outputPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => resolve(outputPath, entry.name));
  });

  if (appPaths.length === 0) {
    throw new Error(
      'Could not find a packaged macOS app for the final ad-hoc signature reset.',
    );
  }

  for (const appPath of appPaths) {
    await runCommand('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      '--deep',
      appPath,
    ]);
  }
};
