import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

const PACKAGED_HELPER_COMPONENTS = [
  'Helpers',
  'Callie Apple Bridge.app',
  'Contents',
  'MacOS',
  'CallieAppleBridge',
] as const;

export type AppleBridgeExecutableOptions = {
  isPackaged: boolean;
  resourcesPath: string;
  developmentExecutablePath: string;
  allowDevelopmentOverride?: boolean;
  environment: Readonly<Record<string, string | undefined>>;
};

export function resolveAppleBridgeExecutable(
  options: AppleBridgeExecutableOptions,
): string {
  if (options.isPackaged) {
    const resourcesPath = normalize(options.resourcesPath);
    const contentsPath = dirname(resourcesPath);
    if (
      !isAbsolute(resourcesPath)
      || basename(resourcesPath) !== 'Resources'
      || basename(contentsPath) !== 'Contents'
    ) {
      throw new Error('Packaged Apple bridge resources path must end in Contents/Resources.');
    }

    return join(contentsPath, ...PACKAGED_HELPER_COMPONENTS);
  }

  const override = options.allowDevelopmentOverride
    ? options.environment.CALLIE_APPLE_BRIDGE_PATH
    : undefined;
  const executablePath = override ?? options.developmentExecutablePath;
  if (!isAbsolute(executablePath)) {
    throw new Error('Development Apple bridge executable path must be absolute.');
  }
  return normalize(executablePath);
}
