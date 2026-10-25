import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { requireLocalDemo, syntheticAssets, demoLabel } from '../support/syntheticBrowserApp.ts';
import { syntheticBrowserCase, syntheticReplySource } from '../support/syntheticBrowserCase.ts';

describe('local synthetic launcher boundary', () => {
  it('requires opt-in and refuses every inherited database/provider/browser selection', () => {
    expect(() => requireLocalDemo({})).toThrow('Explicit');
    requireLocalDemo({ FSS_SYNTHETIC_LOCAL_DEMO: '1' });
    for (const key of ['FSS_TEST_POSTGRES_URL', 'FSS_TEST_CLUSTER_URL', 'FSS_TEST_TEMPLATE_DATABASE', 'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'VERTEX_PROJECT', 'FSS_BROWSER_ORIGIN', 'FSS_PRODUCTION_DATABASE']) {
      expect(() => requireLocalDemo({ FSS_SYNTHETIC_LOCAL_DEMO: '1', [key]: 'not-adoptable' }), key).toThrow('refused');
    }
    expect(() => requireLocalDemo({ FSS_SYNTHETIC_LOCAL_DEMO: '1', FSS_TEST_CLUSTER_URL: '' })).toThrow('refused');
  });
  it('labels current assets persistently without replacing React with a mockup', () => {
    const encoder = new TextEncoder();
    const original = new Map([['/', { body: encoder.encode('<body><div id="root"></div><script src="/renderer.js"></script></body>'), contentType: 'text/html; charset=utf-8' as const }], ['/styles.css', { body: encoder.encode('original-css'), contentType: 'text/css; charset=utf-8' as const }]]);
    const labeled = syntheticAssets(original);
    const html = new TextDecoder().decode(labeled.get('/')!.body);
    expect(html).toContain(demoLabel);
    expect(html).toContain('<div id="root"></div><script src="/renderer.js">');
    expect(html).toContain('Reply drafts themselves are memory-only');
    expect(new TextDecoder().decode(labeled.get('/styles.css')!.body)).toContain('position:sticky');
    expect(new TextDecoder().decode(original.get('/')!.body)).not.toContain(demoLabel);
    expect(() => syntheticAssets(new Map())).toThrow('assets required');
    const missingRoot = new Map(original);
    missingRoot.set('/', { body: encoder.encode('<body>No current product root</body>'), contentType: 'text/html; charset=utf-8' });
    expect(() => syntheticAssets(missingRoot)).toThrow('root required');
  });
  it('retains only fictional original input, never oracle expectations', () => {
    expect(syntheticBrowserCase.messages).toHaveLength(4);
    expect(syntheticBrowserCase.firm).toBe('Fablewick Property Stewardship (invented)');
    expect(syntheticBrowserCase.participants[0]?.email).toBe('mara.fenwick@example.com');
    expect(syntheticReplySource.id).toBe('SYN-A-03');
    expect(syntheticBrowserCase.messages[3]?.direction).toBe('outbound');
    expect(syntheticBrowserCase.messages.map(value => value.id)).toEqual(['SYN-A-01', 'SYN-A-02', 'SYN-A-03', 'SYN-A-04']);
    expect(syntheticBrowserCase).not.toHaveProperty('expected');
    expect(JSON.stringify(syntheticBrowserCase)).not.toMatch(/@(?![a-z.]*example\.com)/u);
  });
  it('launcher fixes Chrome, blocks service workers/downloads and has bounded cleanup', async () => {
    const code = await readFile(new URL('../../scripts/localdemo.ts', import.meta.url), 'utf8');
    expect(code).toContain("serviceWorkers: 'block'");
    expect(code).toContain('acceptDownloads: false');
    expect(code).toContain('lifetime > 30');
    expect(code).toContain("process.on('SIGTERM'");
    expect(code).toContain('await runtime?.stop()');
    expect(code).toContain('await context?.close()');
    expect(code).toContain("process.env['LC_ALL'] = 'en_US.UTF-8'");
    expect(code).toContain('signalListeners.get(signal)!.has(listener)');
    expect(code).not.toContain('process.kill(');
  });
});
