import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(__dirname, '..');

describe('renderer entry point', () => {
  it('uses src/renderer/index.html as the only HTML source of truth', () => {
    const rendererConfig = readFileSync(
      path.join(projectRoot, 'vite.renderer.config.ts'),
      'utf8',
    );

    expect(rendererConfig).toContain("root: 'src/renderer'");
    expect(existsSync(path.join(projectRoot, 'src/renderer/index.html'))).toBe(
      true,
    );
    expect(existsSync(path.join(projectRoot, 'index.html'))).toBe(false);
  });
});
