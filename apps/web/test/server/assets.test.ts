import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildBrowserAssets } from '../../src/server/assets.ts';

describe('local public browser assets', () => {
  it('bundles the existing UI as exactly three stable external public assets', async () => {
    const assets = await buildBrowserAssets();
    expect([...assets.keys()]).toEqual(['/', '/renderer.js', '/styles.css']);
    expect([...assets.values()].map(asset => asset.contentType)).toEqual(['text/html; charset=utf-8', 'text/javascript; charset=utf-8', 'text/css; charset=utf-8']);
    const decode = (path: string): string => new TextDecoder().decode(assets.get(path)!.body);
    const html = decode('/');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" src="/renderer.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(html).not.toMatch(/<style|\sstyle=|\son\w+=|<script(?! type="module" src="\/renderer.js">)/u);
    const script = decode('/renderer.js');
    expect(script.length).toBeGreaterThan(1000);
    expect(script).toContain('/browser/session');
    expect(decode('/styles.css')).toMatch(/:root\{font-family:[^;}]+/u);
    for (const asset of assets.values()) {
      expect(new TextDecoder().decode(asset.body)).not.toMatch(/FSS_BROWSER_|process\.env|import\.meta\.env|unsafe-inline|unsafe-eval|\beval\s*\(|new Function\s*\(|sourceMappingURL/u);
    }
    const again = await buildBrowserAssets();
    for (const [path, asset] of assets) expect(again.get(path)?.body).toEqual(asset.body);
  });

  it('keeps server settings and runtime credentials out of builder inputs', async () => {
    const source = await readFile(new URL('../../src/server/assets.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:settings|runtime|auth)|process\.env(?!\.NODE_ENV)|FSS_BROWSER_|cookieKey/u);
    const settings = await readFile(new URL('../../src/server/settings.ts', import.meta.url), 'utf8');
    expect(settings).not.toMatch(/process\.env|randomBytes/u);
  });
});
