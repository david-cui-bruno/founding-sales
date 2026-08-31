import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveNativeBindingForRuntime } from '../../src/main/db/sqliteDriver';

describe('encrypted SQLite native binding selection', () => {
  it.each(['137', '149'])('selects only the exact Darwin arm64 ABI %s target', (modules) => {
    const exists = vi.fn(() => true);
    const result = resolveNativeBindingForRuntime({
      packageRoot: '/app/node_modules/better-sqlite3-multiple-ciphers',
      platform: 'darwin',
      arch: 'arm64',
      modules,
      exists,
    });

    expect(result).toBe(join(
      '/app/node_modules/better-sqlite3-multiple-ciphers',
      'bin',
      `darwin-arm64-${modules}`,
      'better-sqlite3-multiple-ciphers.node',
    ));
    expect(exists).toHaveBeenCalledWith(result);
  });

  it.each([
    ['darwin', 'arm64', '150'],
    ['darwin', 'x64', '149'],
    ['linux', 'arm64', '137'],
  ])('fails closed for unsupported runtime %s/%s ABI %s', (platform, arch, modules) => {
    const exists = vi.fn(() => true);
    expect(() => resolveNativeBindingForRuntime({
      packageRoot: '/app/node_modules/better-sqlite3-multiple-ciphers',
      platform,
      arch,
      modules,
      exists,
    })).toThrow('unsupported');
    expect(exists).not.toHaveBeenCalled();
  });

  it('fails closed when the exact supported ABI target is missing', () => {
    expect(() => resolveNativeBindingForRuntime({
      packageRoot: '/app/node_modules/better-sqlite3-multiple-ciphers',
      platform: 'darwin',
      arch: 'arm64',
      modules: '149',
      exists: () => false,
    })).toThrow('unavailable');
  });
});
