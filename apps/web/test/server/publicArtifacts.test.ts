import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, symlink, mkdir, truncate, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBrowserAssets } from '../../src/server/publicAssets.ts';

const temporary: string[] = [];
async function directory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'browser-artifacts-')));
  temporary.push(path);
  return path;
}
async function fixture(): Promise<string> {
  const path = await directory();
  await Promise.all(['index.html', 'renderer.js', 'styles.css'].map(name => writeFile(join(path, name), name)));
  return path;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('prebuilt browser artifact boundary', () => {
  it('builds real artifacts without environment substitution and loads exact public routes', async () => {
    const path = await directory();
    const result = spawnSync(process.execPath, ['--experimental-transform-types', 'scripts/buildBrowserAssets.mjs', path], {
      cwd: resolve(import.meta.dirname, '../../../..'), encoding: 'utf8',
      env: { ...process.env, FSS_BROWSER_COOKIE_KEY_HEX: 'artifact_private_canary_not_for_browser', FSS_BROWSER_ORIGIN: 'https://private-canary.invalid' },
    });
    expect(result.stderr, result.stdout).not.toContain('Error');
    expect(result.status).toBe(0);
    const assets = await loadBrowserAssets(path);
    expect([...assets.keys()]).toEqual(['/', '/renderer.js', '/styles.css']);
    expect([...assets.values()].map(asset => asset.contentType)).toEqual(['text/html; charset=utf-8', 'text/javascript; charset=utf-8', 'text/css; charset=utf-8']);
    for (const asset of assets.values()) {
      expect(asset.body.byteLength).toBeGreaterThan(0);
      expect(Buffer.from(asset.body).toString()).not.toMatch(/artifact_private_canary_not_for_browser|private-canary\.invalid|unsafe-eval/u);
    }
    const html = Buffer.from(assets.get('/')!.body).toString();
    expect(html).toContain('src="/renderer.js"');
    expect(html).toContain('href="/styles.css"');
    expect(html).not.toMatch(/<script[^>]*>[^<]+|onload=|style=/u);
  });

  it('ignores unrelated files instead of creating arbitrary serving paths', async () => {
    const path = await fixture();
    await writeFile(join(path, 'secret.env'), 'private');
    expect((await loadBrowserAssets(path)).size).toBe(3);
  });

  it('refuses missing files, directories, empty files and oversized artifacts', async () => {
    for (const filename of ['index.html', 'renderer.js', 'styles.css']) {
      const path = await fixture();
      await rm(join(path, filename));
      await expect(loadBrowserAssets(path)).rejects.toThrow('Invalid browser public assets');
      await mkdir(join(path, filename));
      await expect(loadBrowserAssets(path)).rejects.toThrow('Invalid browser public assets');
      await rm(join(path, filename), { recursive: true });
      await writeFile(join(path, filename), '');
      await expect(loadBrowserAssets(path)).rejects.toThrow('Invalid browser public assets');
      const maximum = filename === 'index.html' ? 65536 : filename === 'renderer.js' ? 8388608 : 1048576;
      await truncate(join(path, filename), maximum);
      expect((await loadBrowserAssets(path)).size).toBe(3);
      await truncate(join(path, filename), maximum + 1);
      await expect(loadBrowserAssets(path)).rejects.toThrow('Invalid browser public assets');
    }
  });

  it('refuses symlink files, root and parent aliases and noncanonical paths', async () => {
    const path = await fixture();
    const other = await directory();
    await rm(join(path, 'renderer.js'));
    await symlink(join(path, 'index.html'), join(path, 'renderer.js'));
    await expect(loadBrowserAssets(path)).rejects.toThrow('Invalid browser public assets');
    await symlink(path, join(other, 'alias'));
    await expect(loadBrowserAssets(join(other, 'alias'))).rejects.toThrow('Invalid browser public assets');
    await expect(loadBrowserAssets(join(other, 'alias', 'nested'))).rejects.toThrow('Invalid browser public assets');
    for (const invalid of ['.', `${path}/../escape`, `${path}/`, `${path}\0`]) {
      await expect(loadBrowserAssets(invalid)).rejects.toThrow('Invalid browser public assets');
    }
  });

  it('keeps the loader runnable with no build tool or client source', async () => {
    const path = await fixture();
    await writeFile(join(path, 'package.json'), '{"type":"module"}');
    await writeFile(join(path, 'publicAssets.ts'), await readFile(new URL('../../src/server/publicAssets.ts', import.meta.url)));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'const {loadBrowserAssets}=await import(process.argv[1]); if((await loadBrowserAssets(process.argv[2])).size!==3) process.exit(1)', join(path, 'publicAssets.ts'), path], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('packages locked build tools separately and includes runtime modules and assets', async () => {
    const docker = await readFile(new URL('../../../../Dockerfile.api', import.meta.url), 'utf8');
    const runtime = docker.split('AS runtime')[1]!;
    expect(docker).toContain('--workspace @fss/web');
    expect(docker).toContain('--include-workspace-root');
    expect(docker).toContain('COPY package.json package-lock.json ./');
    expect(docker).toContain('scripts/buildBrowserAssets.mjs /app/browser-public');
    expect(runtime).toContain('COPY apps/web/package.json apps/web/');
    expect(runtime).toContain('COPY apps/web/src/server apps/web/src/server');
    expect(runtime).toContain('COPY apps/web/src/shared apps/web/src/shared');
    expect(runtime).toContain('COPY --from=browser-build /app/browser-public ./browser-public');
    expect(runtime).toContain('RUN rm apps/web/src/server/assets.ts apps/web/src/server/server.ts');
    expect(runtime).not.toMatch(/^RUN .*npm ci/mu);
    expect(runtime).not.toContain('COPY apps/web/src/client');
    expect(runtime).toContain('ENTRYPOINT ["node", "apps/api/src/bootstrap/main.ts"]');
  });
});

describe.runIf(process.env['FSS_ARTIFACT_IMAGE'])('built API image offline packaging', () => {
  const image = process.env['FSS_ARTIFACT_IMAGE'] ?? '';
  it('preserves the offline selftest under read-only and network-none constraints', async () => {
    const source = await readFile(new URL('../../../../packages/domain/db/schemaRange.ts', import.meta.url), 'utf8');
    const schema = /export const REQUIRED_SCHEMA = (\d+);/u.exec(source)![1]!;
    const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '-e', `FSS_SCHEMA_MIN=${schema}`, '-e', `FSS_SCHEMA_MAX=${schema}`, '-e', 'DATABASE_URL=postgresql://offline.invalid/offline', '-e', 'FSS_DEPENDENCIES=none', image, '--selftest'], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
  });

  it('loads real assets and server imports with production dependencies but no build tools', () => {
    const script = `
      import {loadBrowserAssets} from './apps/web/src/server/publicAssets.ts';
      import {createBrowserHostHandler} from './apps/web/src/server/host.ts';
      import {access} from 'node:fs/promises';
      import {createRequire} from 'node:module';
      const require=createRequire(import.meta.url);
      if((await loadBrowserAssets('/app/browser-public')).size!==3 || typeof createBrowserHostHandler!=='function') throw Error('Invalid runtime');
      for(const name of ['react','zod','@fss/contracts']) require.resolve(name);
      for(const name of ['esbuild','electron','typescript']) {
        try { require.resolve(name); } catch { continue; }
        throw Error('Unexpected build dependency');
      }
      for(const path of ['apps/web/src/client','apps/web/src/server/assets.ts','apps/web/src/server/server.ts']) {
        try { await access(path); } catch { continue; }
        throw Error('Unexpected build source');
      }
    `;
    const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', image, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
  });
});
