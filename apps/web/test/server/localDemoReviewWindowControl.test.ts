import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReviewCore from '../../scripts/localdemoReviewWindowCore.ts';
import type { ReviewReceipt } from '../../scripts/localdemoReviewWindowCore.ts';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const fake = vi.hoisted(() => ({ directory: '', native: vi.fn<(args: string[]) => string>() }));
vi.mock('../../scripts/localdemoReviewWindowCore.ts', async importOriginal => {
  const actual = await importOriginal<typeof ReviewCore>();
  return { ...actual, reviewDirectory: () => fake.directory, launchctl: fake.native,
    checkReviewStart: (env: NodeJS.ProcessEnv) => actual.checkReviewStart(env, 'darwin'),
    readReviewReceipt: () => actual.readReviewReceipt(fake.directory),
    assertOwnedService: (receipt: ReviewReceipt) => actual.assertOwnedService(receipt, fake.native) };
});
const core = await vi.importActual<typeof ReviewCore>('../../scripts/localdemoReviewWindowCore.ts');
const { startReviewWindow, stopReviewWindow } = await import('../../scripts/localdemoReviewWindow.ts');

let parent = '';
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'fss-review-unit-'));
  fake.directory = join(parent, 'lease');
  fake.native.mockReset().mockReturnValue('');
  for (const key of Object.keys(process.env)) {
    if (/^(?:FSS_TEST_(?:POSTGRES_URL|CLUSTER_URL|TEMPLATE_DATABASE)|DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|AWS_|GOOGLE_|VERTEX_|FSS_BROWSER_|FSS_PRODUCTION_)/u.test(key)) vi.stubEnv(key, undefined);
  }
  vi.stubEnv('FSS_SYNTHETIC_LOCAL_DEMO', '1');
  vi.stubEnv('FSS_LOCAL_DEMO_MINUTES', '11');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(parent, { recursive: true, force: true }); });

function listing(receipt: ReviewReceipt): string {
  return `path = ${join(receipt.directory, 'review.plist')}\nprogram = ${receipt.node}\n${receipt.script}\n${receipt.directory}`;
}

describe('bounded OS-owned review window control', () => {
  it('fails closed before acquisition without opt-in, on unsupported OS or inherited provider/database settings', async () => {
    expect(() => core.checkReviewStart({}, 'darwin')).toThrow('Explicit');
    expect(() => core.checkReviewStart({ FSS_SYNTHETIC_LOCAL_DEMO: '1' }, 'linux')).toThrow('macOS');
    for (const key of ['FSS_TEST_CLUSTER_URL', 'FSS_TEST_POSTGRES_URL', 'FSS_TEST_TEMPLATE_DATABASE', 'PGHOST', 'DATABASE_URL', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'VERTEX_PROJECT', 'FSS_BROWSER_ORIGIN', 'FSS_PRODUCTION_DATABASE']) {
      expect(() => core.checkReviewStart({ FSS_SYNTHETIC_LOCAL_DEMO: '1', [key]: key.startsWith('FSS_TEST_') ? '' : 'refuse' }, 'darwin'), key).toThrow('refused');
    }
    for (const value of ['0', '31', '1.5', 'NaN']) expect(() => core.checkReviewStart({ FSS_SYNTHETIC_LOCAL_DEMO: '1', FSS_LOCAL_DEMO_MINUTES: value }, 'darwin')).toThrow('1..30');
    vi.stubEnv('FSS_SYNTHETIC_LOCAL_DEMO', '');
    await expect(startReviewWindow()).rejects.toThrow('Explicit');
    await expect(lstat(fake.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.native).not.toHaveBeenCalled();
  });
  it('atomically refuses duplicate starts and creates only a private one-shot, non-autostart plist', async () => {
    const receipt = await startReviewWindow();
    await expect(startReviewWindow()).rejects.toThrow('already exists');
    expect(fake.native.mock.calls).toEqual([[['bootstrap', `gui/${process.getuid!()}`, join(fake.directory, 'review.plist')]]]);
    expect((await lstat(fake.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(fake.directory, 'receipt.json'))).mode & 0o777).toBe(0o600);
    const plist = await readFile(join(fake.directory, 'review.plist'), 'utf8');
    expect(plist).toContain('<key>KeepAlive</key><false/>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).not.toContain('LaunchAgents');
    expect(receipt.state).toBe('starting');
    expect(receipt.minutes).toBe(11);
    expect(receipt).not.toHaveProperty('resources');
  });
  it('requests cancellation even while starting using only a verified unique service and persistent marker', async () => {
    const receipt = await startReviewWindow();
    fake.native.mockReturnValue(listing(receipt));
    await stopReviewWindow();
    await stopReviewWindow();
    expect((await lstat(join(fake.directory, 'stop-requested'))).mode & 0o777).toBe(0o600);
    expect(fake.native.mock.calls.slice(1)).toEqual([[['print', receipt.target]], [['print', receipt.target]]]);
    expect(JSON.parse(await readFile(join(fake.directory, 'receipt.json'), 'utf8'))).toEqual(receipt);
  });
  it('refuses an unrelated service without writing cancellation or signaling any PID', async () => {
    const receipt = await startReviewWindow();
    fake.native.mockReturnValue(listing({ ...receipt, node: '/unrelated/node' }));
    await expect(stopReviewWindow()).rejects.toThrow('ownership mismatch');
    await expect(lstat(join(fake.directory, 'stop-requested'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.native.mock.calls.slice(1)).toEqual([[['print', receipt.target]]]);
  });
  it('preserves ownership evidence after an unknown bootstrap outcome', async () => {
    fake.native.mockImplementation(() => { throw Error('bootstrap unknown'); });
    await expect(startReviewWindow()).rejects.toThrow('bootstrap unknown');
    const receipt = await core.readReviewReceipt(fake.directory);
    expect(receipt.state).toBe('starting');
    await expect(startReviewWindow()).rejects.toThrow('already exists');
  });
  it('rejects foreign target, loose permissions and symlink receipts', async () => {
    const receipt = await startReviewWindow();
    const path = join(fake.directory, 'receipt.json');
    await writeFile(path, JSON.stringify({ ...receipt, target: `gui/${process.getuid!()}/dev.callie.local-review.${randomUUID()}` }));
    await expect(core.readReviewReceipt(fake.directory)).rejects.toThrow('Invalid owned');
    await writeFile(path, JSON.stringify(receipt));
    await chmod(fake.directory, 0o755);
    await expect(core.readReviewReceipt(fake.directory)).rejects.toThrow('Unsafe review directory');
    await chmod(fake.directory, 0o700);
    await rm(path);
    await writeFile(join(parent, 'foreign.json'), JSON.stringify(receipt), { mode: 0o600 });
    await symlink(join(parent, 'foreign.json'), path);
    await expect(core.readReviewReceipt(fake.directory)).rejects.toThrow('Unsafe review receipt');
  });
  it('escapes plist arguments and does not propagate extra inherited settings', async () => {
    const receipt = await startReviewWindow();
    const plist = core.reviewPlist({ ...receipt, node: '/node/with<&"chars' }, { HOME: '/home', PATH: '/bin', UNRELATED_SECRET: 'not-copied' });
    expect(plist).toContain('/node/with&lt;&amp;&quot;chars');
    expect(plist).not.toContain('not-copied');
    expect(plist).not.toContain('UNRELATED_SECRET');
  });
});
