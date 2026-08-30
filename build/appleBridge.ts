import type { ForgeHookMap } from '@electron-forge/shared-types';

import {
  buildAppleBridgeBundle,
  copyAppleBridgeBundle,
  prepareAppleBridgePackage,
} from '../scripts/buildAppleBridge.mjs';
import {
  applyElectronFuses,
  resetPackagedAdHocSignature,
} from './electronFuses';

const appleBridgeEntitlementsPath =
  'native/apple-bridge/Resources/CallieAppleBridge.entitlements';

export const createAppleBridgeSigningOptions = (
  signingIdentity: string | undefined,
) =>
  signingIdentity === undefined
    ? undefined
    : {
        identity: signingIdentity,
        hardenedRuntime: true,
        optionsForFile: (filePath: string) =>
          filePath.includes('Callie Apple Bridge.app')
            ? { entitlements: appleBridgeEntitlementsPath }
            : {},
      };

const hasConfiguredMacSigning = (value: unknown): boolean =>
  (typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length > 0) ||
  Boolean(value);

interface AppleBridgeForgeHookDependencies {
  projectRoot: string;
  generateAssets?: typeof generateAppleBridgeAssets;
  preparePackage?: typeof prepareAppleBridgePackage;
  applyFuses?: typeof applyElectronFuses;
  resetAdHocSignature?: typeof resetPackagedAdHocSignature;
}

export const createAppleBridgeForgeHooks = ({
  projectRoot,
  generateAssets = generateAppleBridgeAssets,
  preparePackage = prepareAppleBridgePackage,
  applyFuses = applyElectronFuses,
  resetAdHocSignature = resetPackagedAdHocSignature,
}: AppleBridgeForgeHookDependencies): ForgeHookMap => ({
  generateAssets: async (_resolvedConfig, platform, arch) => {
    if (platform === 'darwin' && arch === 'arm64') {
      await generateAssets(projectRoot, platform, arch);
    }
  },
  packageAfterCopy: async (
    resolvedConfig,
    buildPath,
    _electronVersion,
    platform,
    arch,
  ) => {
    const configuredSigning = hasConfiguredMacSigning(
      resolvedConfig.packagerConfig.osxSign,
    );
    await preparePackage({
      projectRoot,
      buildPath,
      platform,
      arch,
      hasConfiguredMacSigning: configuredSigning,
    });
    await applyFuses(
      buildPath,
      platform,
      arch,
      configuredSigning,
    );
  },
  postPackage: async (resolvedConfig, packageResult) => {
    await resetAdHocSignature(
      packageResult.outputPaths,
      packageResult.platform,
      packageResult.arch,
      hasConfiguredMacSigning(resolvedConfig.packagerConfig.osxSign),
    );
  },
});

export const generateAppleBridgeAssets = async (
  projectRoot: string,
  platform: string,
  arch: string,
): Promise<string | undefined> => {
  if (platform !== 'darwin' || arch !== 'arm64') {
    return undefined;
  }

  const result = await buildAppleBridgeBundle({
    projectRoot,
    platform,
    arch,
  });
  return result.bundlePath;
};

export {
  buildAppleBridgeBundle,
  copyAppleBridgeBundle,
  prepareAppleBridgePackage,
};
