import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReviewCore from '../../scripts/localdemoReviewWindowCore.ts';
import type { ReviewReceipt } from '../../scripts/localdemoReviewWindowCore.ts';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const fake = vi.hoisted(() => ({ directory: '', native: vi.fn<(args: string[]) => string>(), afterOwnership: undefined as undefined | (() => Promise<void>), afterLease: undefined as undefined | (() => Promise<void>) }));
vi.mock('../../scripts/localdemoReviewWindowCore.ts', async importOriginal => {
  const actual = await importOriginal<typeof ReviewCore>();
  return { ...actual, reviewDirectory: () => fake.directory, launchctl: fake.native,
    checkReviewStart: (env: NodeJS.ProcessEnv) => actual.checkReviewStart(env, 'darwin'),
    readReviewReceipt: () => actual.readReviewReceipt(fake.directory),
    inspectReviewService: (receipt: ReviewReceipt) => actual.inspectReviewService(receipt, fake.native),
    assertSameReviewLease: async (receipt: ReviewReceipt) => {
      const result = await actual.assertSameReviewLease(receipt);
      await fake.afterLease?.();
      return result;
    },
    assertOwnedService: async (receipt: ReviewReceipt) => {
      const result = await actual.assertOwnedService(receipt, fake.native);
      await fake.afterOwnership?.();
      return result;
    } };
});
const core = await vi.importActual<typeof ReviewCore>('../../scripts/localdemoReviewWindowCore.ts');
const { startReviewWindow, stopReviewWindow, finalizeReviewWindow, runReviewSession, readReviewStatus } = await import('../../scripts/localdemoReviewWindow.ts');

let parent = '';
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'fss-review-unit-'));
  fake.directory = join(parent, 'lease');
  fake.native.mockReset().mockReturnValue('');
  fake.afterOwnership = undefined;
  fake.afterLease = undefined;
  for (const key of Object.keys(process.env)) {
    if (/^(?:FSS_TEST_(?:POSTGRES_URL|CLUSTER_URL|TEMPLATE_DATABASE)|DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|AWS_|GOOGLE_|VERTEX_|FSS_BROWSER_|FSS_PRODUCTION_)/u.test(key)) vi.stubEnv(key, undefined);
  }
  vi.stubEnv('FSS_SYNTHETIC_LOCAL_DEMO', '1');
  vi.stubEnv('FSS_LOCAL_DEMO_MINUTES', '11');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(parent, { recursive: true, force: true }); });

function listing(receipt: ReviewReceipt): string {
  // launchctl reports a canonical plist path, including when macOS tmpdir is an alias.
  return `path = ${realpathSync(join(receipt.directory, 'review.plist'))}\nprogram = ${receipt.node}\n${receipt.script}\n${receipt.directory}`;
}

function missing(receipt: ReviewReceipt): Error {
  return Object.assign(Error('exact service absent'), { status: 113, stderr: `Could not find service "${receipt.label}" in domain for user gui: ${process.getuid!()}` });
}

async function finalizing(receipt: ReviewReceipt): Promise<void> {
  receipt.state = 'finalizing';
  receipt.resourcesStopped = true;
  receipt.finalization = { token: randomUUID(), pid: process.pid, expiresAt: new Date(Date.now() + 30_000).toISOString(), outcome: 'pending' };
  await mkdir(join(receipt.directory, `finalizer-${receipt.label}`));
  await writeFile(join(receipt.directory, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
}

describe('bounded OS-owned review window control', () => {
  it('rejects a paused A stop after A teardown and B acquisition at the same pathname', async () => {
    const a = await startReviewWindow();
    fake.native.mockReturnValue(listing(a));
    let resume = (): void => {};
    let validated = (): void => {};
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const reached = new Promise<void>(resolve => { validated = resolve; });
    fake.afterOwnership = async () => { validated(); await paused; };
    const staleStop = stopReviewWindow();
    await reached;
    fake.afterOwnership = undefined;
    await rm(fake.directory, { recursive: true });
    const b = await startReviewWindow();
    fake.native.mockReturnValue(listing(b));
    resume();
    await expect(staleStop).rejects.toThrow('lease changed');
    await expect(lstat(join(fake.directory, 'stop-requested'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await core.readReviewReceipt(fake.directory)).label).toBe(b.label);
  });
  it('retains exact evidence and duplicate exclusion if final native bootout fails', async () => {
    const receipt = await startReviewWindow();
    await finalizing(receipt);
    fake.native.mockImplementation(args => {
      if (args[0] === 'bootout') throw Error('bootout unknown');
      return listing(receipt);
    });
    await expect(finalizeReviewWindow(receipt)).rejects.toThrow('bootout unknown');
    await expect(lstat(fake.directory)).resolves.toBeDefined();
    expect((await core.readReviewReceipt(fake.directory)).label).toBe(receipt.label);
    expect((await readReviewStatus()).state).toBe('finalization-failed');
    await expect(startReviewWindow()).rejects.toThrow('already exists');
  });
  it('rejects paused failed-finalization recovery across successor acquisition without overwriting its receipt', async () => {
    const a = await startReviewWindow();
    await finalizing(a);
    a.state = 'finalization-failed';
    await writeFile(join(a.directory, 'receipt.json'), JSON.stringify(a));
    let resume = (): void => {};
    let validated = (): void => {};
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const reached = new Promise<void>(resolve => { validated = resolve; });
    fake.afterLease = async () => { validated(); await paused; };
    const staleStop = stopReviewWindow();
    await reached;
    fake.afterLease = undefined;
    await rm(a.directory, { recursive: true });
    const b = await startReviewWindow();
    resume();
    await expect(staleStop).rejects.toThrow('lease changed');
    expect((await core.readReviewReceipt(b.directory)).label).toBe(b.label);
    await expect(lstat(join(b.directory, `finalizer-${a.label}`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not launch a competing finalizer while current finalization is pending', async () => {
    const receipt = await startReviewWindow();
    await finalizing(receipt);
    fake.native.mockClear();
    await stopReviewWindow();
    expect(fake.native).not.toHaveBeenCalled();
    expect(await core.readReviewReceipt(receipt.directory)).toEqual(receipt);
  });
  it('does not confuse foreign-label not-found output with exact native absence', async () => {
    const receipt = await startReviewWindow();
    const error = Object.assign(Error('foreign missing'), { status: 113, stderr: 'Could not find service "another-service"' });
    await expect(core.inspectReviewService(receipt, () => { throw error; })).rejects.toBe(error);
  });
  it('retains evidence when successful bootout is followed by unknown native absence', async () => {
    const receipt = await startReviewWindow();
    await finalizing(receipt);
    let bootedOut = false;
    fake.native.mockImplementation(args => {
      if (args[0] === 'bootout') { bootedOut = true; return ''; }
      if (bootedOut) throw Error('print timed out');
      return listing(receipt);
    });
    await expect(finalizeReviewWindow(receipt)).rejects.toThrow('print timed out');
    const retained = await core.readReviewReceipt(fake.directory);
    expect(retained.state).toBe('finalization-failed');
    expect(retained.finalization?.outcome).toBe('failed-or-unknown');
    await expect(startReviewWindow()).rejects.toThrow('already exists');
  });
  it('removes the lease only after successful bootout and exact confirmed native absence', async () => {
    const receipt = await startReviewWindow();
    await finalizing(receipt);
    let bootedOut = false;
    fake.native.mockImplementation(args => {
      if (args[0] === 'bootout') { bootedOut = true; return ''; }
      if (bootedOut) throw missing(receipt);
      return listing(receipt);
    });
    await finalizeReviewWindow(receipt);
    await expect(lstat(fake.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('can reconcile already-absent native service without discarding uncertain fixture resources', async () => {
    const receipt = await startReviewWindow();
    await finalizing(receipt);
    receipt.resourcesStopped = false;
    await writeFile(join(receipt.directory, 'receipt.json'), JSON.stringify(receipt));
    fake.native.mockImplementation(() => { throw missing(receipt); });
    await finalizeReviewWindow(receipt);
    expect((await readReviewStatus()).state).toBe('failed');
    expect((await readReviewStatus()).service).toBeNull();
    expect((await core.readReviewReceipt(fake.directory)).finalization?.outcome).toBe('native-removed');
    await expect(startReviewWindow()).rejects.toThrow('already exists');
  });
  it('ignores stale generation markers without overwriting a valid current cancellation', async () => {
    const a = await startReviewWindow();
    await rm(fake.directory, { recursive: true });
    const b = await startReviewWindow();
    const old = JSON.stringify({ label: a.label, target: a.target });
    await writeFile(core.reviewStopPath(a), old);
    expect(await core.reviewStopRequested(b)).toBe(false);
    await core.requestReviewStop(b);
    await writeFile(core.reviewStopPath(a), old);
    expect(await core.reviewStopRequested(b)).toBe(true);
    await writeFile(core.reviewStopPath(b), old);
    expect(await core.reviewStopRequested(b)).toBe(false);
  });
  it.each(['stop', 'Chrome close', 'expiry'])('publishes non-ready before paused teardown from %s', async () => {
    const receipt = await startReviewWindow();
    fake.native.mockReturnValue(listing(receipt));
    let resume = (): void => {};
    let closing = (): void => {};
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const teardown = new Promise<void>(resolve => { closing = resolve; });
    const run = runReviewSession(receipt, async options => {
      await options?.onReady?.({ origin: 'https://localhost:1', expiresAt: '2099-01-01T00:00:00Z' });
      await options?.onStopping?.();
      closing();
      await paused;
    });
    await teardown;
    try { expect((await readReviewStatus()).state).toBe('stopping'); }
    finally { resume(); await run; }
  });
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
    expect((await lstat(core.reviewStopPath(receipt))).mode & 0o777).toBe(0o600);
    expect(await core.reviewStopRequested(receipt)).toBe(true);
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
