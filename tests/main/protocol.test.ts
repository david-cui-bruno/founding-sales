import { describe, expect, it } from 'vitest';
import { resolveRendererAsset } from '../../src/main/protocol';

describe('resolveRendererAsset', () => {
  it('resolves a renderer asset beneath the supplied bundle root', () => {
    expect(resolveRendererAsset('/app/renderer', '/assets/main.js')).toBe(
      '/app/renderer/assets/main.js',
    );
  });

  it('rejects a decoded path that escapes the renderer bundle', () => {
    expect(() =>
      resolveRendererAsset('/app/renderer', '../../etc/passwd'),
    ).toThrow();

    expect(() =>
      resolveRendererAsset('/app/renderer', '/%2e%2e/%2e%2e/etc/passwd'),
    ).toThrow();
  });
});
