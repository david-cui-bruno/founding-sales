import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
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
    expect(code).toContain('await prepareSyntheticCliDependency()');
    const startup = code.indexOf('await startSyntheticBrowser({ manualPreparation })');
    expect(startup).toBeGreaterThan(0);
    expect(code.indexOf('await prepareSyntheticCliDependency()')).toBeLessThan(startup);
    expect(code).not.toContain('process.kill(');
  });
  it.skipIf(process.env['FSS_SYNTHETIC_STARTUP_PROOF'] !== '1')('SIGTERM after PG import and TLS acquisition cancels startup before Chrome/READY and cleans owned resources', async () => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../../scripts/localdemo.ts', import.meta.url))], {
      env: { HOME: process.env['HOME']!, PATH: process.env['PATH']!, TMPDIR: process.env['TMPDIR']!, LC_ALL: 'en_US.UTF-8', FSS_SYNTHETIC_LOCAL_DEMO: '1', FSS_LOCAL_DEMO_MINUTES: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', signalled = false;
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (!signalled && output.includes('REPLY_BRIEF_OWNED_RESOURCES ')) {
        signalled = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
        timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('Owned startup subprocess timed out')); }, 45_000);
      });
    } finally { clearTimeout(timer); }
    console.log('SYNTHETIC_781_STARTUP_INTERRUPTION_RECEIPT', output);
    expect(signalled).toBe(true);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(output).toContain('SYNTHETIC_BROWSER_DEPENDENCY_READY');
    expect(output).toContain('SYNTHETIC_BROWSER_SHUTDOWN_REQUESTED {"duringStartup":true}');
    expect(output).toContain('SYNTHETIC_BROWSER_STARTUP_CANCELLED');
    expect(output).not.toContain('SYNTHETIC_BROWSER_DEMO_READY');
    expect(output).toContain('SYNTHETIC_BROWSER_CLUSTER_PID_DIRECTORY_ABSENT');
    expect(output).toContain('SYNTHETIC_BROWSER_DEMO_STOPPED');
    const parse = <T,>(label: string): T => JSON.parse(output.split('\n').find(line => line.startsWith(`${label} `))!.slice(label.length + 1)) as T;
    const starting = parse<{ pid: number; profile: string }>('SYNTHETIC_BROWSER_STARTING');
    const owned = parse<{ storagePath: string; postgresPid: number; tlsPath: string }>('REPLY_BRIEF_OWNED_RESOURCES');
    const cancelled = parse<{ origin: string; oidcIssuer: string }>('SYNTHETIC_BROWSER_STARTUP_CANCELLED');
    for (const path of [starting.profile, owned.storagePath, owned.tlsPath]) expect(existsSync(path), path).toBe(false);
    for (const pid of [starting.pid, owned.postgresPid]) expect(() => process.kill(pid, 0)).toThrow();
    expect(execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' })).not.toContain(`--user-data-dir=${starting.profile}`);
    process.kill(1106, 0);
    for (const address of [cancelled.origin, cancelled.oidcIssuer]) {
      const url = new URL(address);
      const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        const socket = connect({ host: url.hostname, port: Number(url.port) });
        socket.once('connect', () => { socket.destroy(); reject(Error('Owned listener remains')); });
        socket.once('error', resolve);
      });
      expect(error.code).toBe('ECONNREFUSED');
    }
  }, 60_000);
});
