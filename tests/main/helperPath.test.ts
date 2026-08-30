import { describe, expect, it } from 'vitest';

import { resolveAppleBridgeExecutable } from '../../src/main/appleBridge/helperPath';

describe('resolveAppleBridgeExecutable', () => {
  it('ignores packaged overrides and resolves only inside Contents/Helpers', () => {
    expect(resolveAppleBridgeExecutable({
      isPackaged: true,
      resourcesPath: '/Applications/Callie.app/Contents/Resources',
      developmentExecutablePath: '/tmp/development-helper',
      allowDevelopmentOverride: true,
      environment: { CALLIE_APPLE_BRIDGE_PATH: '/tmp/attacker' },
    })).toBe(
      '/Applications/Callie.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
    );
  });

  it('requires a canonical macOS bundle Resources path in packaged mode', () => {
    expect(() => resolveAppleBridgeExecutable({
      isPackaged: true,
      resourcesPath: '/Applications/Callie.app/Resources',
      developmentExecutablePath: '/tmp/development-helper',
      environment: {},
    })).toThrow('Contents/Resources');
  });

  it('uses an environment override only after an explicit development opt-in', () => {
    const common = {
      isPackaged: false,
      resourcesPath: '/unused',
      developmentExecutablePath: '/workspace/native/apple-bridge/.build/release/CallieAppleBridge',
      environment: { CALLIE_APPLE_BRIDGE_PATH: '/tmp/explicit-helper' },
    } as const;

    expect(resolveAppleBridgeExecutable(common)).toBe(common.developmentExecutablePath);
    expect(resolveAppleBridgeExecutable({
      ...common,
      allowDevelopmentOverride: true,
    })).toBe('/tmp/explicit-helper');
  });

  it('rejects relative development executable paths', () => {
    expect(() => resolveAppleBridgeExecutable({
      isPackaged: false,
      resourcesPath: '/unused',
      developmentExecutablePath: './CallieAppleBridge',
      environment: {},
    })).toThrow('absolute');
  });
});
