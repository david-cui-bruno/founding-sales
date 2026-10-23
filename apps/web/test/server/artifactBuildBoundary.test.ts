import { beforeEach, describe, expect, it, vi } from 'vitest';

const compiler = vi.hoisted(() => vi.fn());
vi.mock('esbuild', () => ({ build: compiler }));
import { buildBrowserAssets } from '../../src/server/assets.ts';

function output(inputs: string[] = ['src/client/main.tsx']) {
  return {
    metafile: { inputs: Object.fromEntries(inputs.map(path => [path, {}])) },
    outputFiles: [
      { path: '/build/renderer.js', contents: new TextEncoder().encode('export {};') },
      { path: '/build/renderer.css', contents: new TextEncoder().encode('body{}') },
    ],
  };
}
beforeEach(() => compiler.mockReset());

describe('image build dependency boundary', () => {
  it.each(['src/server/cookies.ts', '../desktop/electron/preload.ts', '.env', '.env.production', 'src/.env.local/config.ts'])('refuses private/native dependency %s before producing artifacts', async input => {
    compiler.mockResolvedValue(output([input]));
    await expect(buildBrowserAssets()).rejects.toThrow('Invalid browser public asset dependency');
  });

  it('refuses absent, empty or additional compiler outputs', async () => {
    const empty = output();
    empty.outputFiles[0]!.contents = new Uint8Array();
    const extra = output();
    extra.outputFiles.push({ path: '/build/private.map', contents: new Uint8Array([1]) });
    const missing = output();
    missing.outputFiles.pop();
    for (const result of [empty, extra, missing]) {
      compiler.mockResolvedValue(result);
      await expect(buildBrowserAssets()).rejects.toThrow('Invalid browser public asset output');
    }
  });

  it('has no configuration/environment replacement, source maps or eval-based runtime', async () => {
    compiler.mockResolvedValue(output());
    await buildBrowserAssets();
    expect(compiler).toHaveBeenCalledWith(expect.objectContaining({
      define: { 'process.env.NODE_ENV': '"production"' },
      platform: 'browser', format: 'esm', bundle: true, write: false,
      sourcemap: false, metafile: true,
    }));
    expect(Object.keys(compiler.mock.calls[0]![0].define)).toEqual(['process.env.NODE_ENV']);
  });
});
