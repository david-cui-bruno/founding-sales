import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { runLocalDemo } from './localdemo.ts';
import { assertOwnedService, assertSameReviewLease, checkReviewStart, inspectReviewService, launchctl, readReviewReceipt, requestReviewStop, reviewDirectory, reviewPlist, reviewStopRequested, shellQuote, type ReviewReceipt } from './localdemoReviewWindowCore.ts';

async function persist(receipt: ReviewReceipt): Promise<void> {
  const temporary = join(receipt.directory, 'receipt.next');
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(receipt.directory, 'receipt.json'));
}

export async function startReviewWindow(): Promise<ReviewReceipt> {
  const minutes = checkReviewStart(process.env);
  const directory = reviewDirectory();
  // Atomic lease. Never reclaim a previous runtime merely because its PID died.
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error(`Review lease already exists: ${directory}. Inspect status/stop, never launch a duplicate.`); throw error; }
  const label = `dev.callie.local-review.${randomUUID()}`;
  const script = fileURLToPath(import.meta.url);
  const control = `env TMPDIR=${shellQuote(process.env['TMPDIR'] ?? directory.slice(0, directory.lastIndexOf('/')))} ${[process.execPath, '--experimental-transform-types', '--disable-warning=ExperimentalWarning', script].map(shellQuote).join(' ')}`;
  const receipt: ReviewReceipt = { version: 1, label, target: `gui/${process.getuid!()}/${label}`, directory, node: process.execPath, script, createdAt: new Date().toISOString(), minutes, state: 'starting', controls: { status: `${control} status`, stop: `${control} stop`, log: join(directory, 'runtime.log') } };
  let bootstrapping = false;
  try {
    await persist(receipt);
    await writeFile(join(directory, 'review.plist'), reviewPlist(receipt, process.env), { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'runtime.log'), '', { mode: 0o600, flag: 'wx' });
    bootstrapping = true;
    launchctl(['bootstrap', `gui/${process.getuid!()}`, join(directory, 'review.plist')]);
    return receipt;
  } catch (error) {
    if (!bootstrapping) await rm(directory, { recursive: true, force: true });
    // Failed bootstrap can have an unknown outcome. Keep the ownership evidence.
    throw error;
  }
}

export async function stopReviewWindow(): Promise<void> {
  const receipt = await readReviewReceipt();
  if (receipt.resourcesStopped) {
    if (receipt.state === 'finalization-failed') await beginReviewFinalization(receipt, true);
    console.error('REVIEW_WINDOW_FINALIZATION_REQUESTED', JSON.stringify({ target: receipt.target, directory: receipt.directory }));
    return;
  }
  await assertOwnedService(receipt);
  await requestReviewStop(receipt);
  console.error('REVIEW_WINDOW_STOP_REQUESTED', JSON.stringify({ target: receipt.target, directory: receipt.directory }));
}

/** The receipt writer hands off only after fixture teardown. A detached finite
 * child has its own process group, so bootout cannot kill its cleanup owner. No
 * additional launchd definition, KeepAlive or persistent service is created. */
export async function beginReviewFinalization(receipt: ReviewReceipt, clean: boolean): Promise<void> {
  await assertSameReviewLease(receipt);
  const lock = join(receipt.directory, `finalizer-${receipt.label}`);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  try { await assertSameReviewLease(receipt); }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  receipt.state = 'finalizing';
  receipt.resourcesStopped = clean;
  receipt.finalization = { token: randomUUID(), expiresAt: new Date(Date.now() + 30_000).toISOString(), outcome: 'pending' };
  await persist(receipt);
  const log = await open(join(receipt.directory, 'runtime.log'), 'a', 0o600);
  try {
    const child = spawn(receipt.node, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', receipt.script, 'finalize', receipt.directory, receipt.label, receipt.finalization.token], {
      detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { HOME: process.env['HOME'], PATH: process.env['PATH'], TMPDIR: tmpdir() },
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (child.pid === undefined) throw Error('Finalizer PID unavailable. Lease retained.');
    receipt.finalization.pid = child.pid;
    await persist(receipt);
    child.unref();
    console.error('REVIEW_WINDOW_FINALIZER_STARTED', JSON.stringify(receipt.finalization));
  } finally { await log.close(); }
}

async function assertFinalizer(receipt: ReviewReceipt): Promise<void> {
  const current = await assertSameReviewLease(receipt);
  if (!receipt.finalization || current.finalization?.token !== receipt.finalization.token || current.finalization.pid !== process.pid || Date.parse(current.finalization.expiresAt) <= Date.now()) throw Error('Finalizer ownership or deadline refused');
}

/** Runs outside the supervisor's process group. Never delete evidence on a
 * rejected/unknown bootout or print. Only confirmed exact native absence allows
 * removal. Failed attempts unlock for an explicit stop retry, without auto-retry. */
export async function finalizeReviewWindow(receipt: ReviewReceipt): Promise<void> {
  await assertFinalizer(receipt);
  let removed = false;
  try {
    const service = await inspectReviewService(receipt);
    if (service !== null) launchctl(['bootout', receipt.target]);
    const deadline = Math.min(Date.parse(receipt.finalization!.expiresAt), Date.now() + 5000);
    while (await inspectReviewService(receipt) !== null) {
      if (Date.now() >= deadline) throw Error('Native removal unconfirmed');
      await delay(100);
    }
    await assertFinalizer(receipt);
    if (receipt.resourcesStopped) {
      await rm(receipt.directory, { recursive: true, force: true });
      removed = true;
      return;
    }
    receipt.state = 'failed';
    receipt.finalization!.outcome = 'native-removed';
    await persist(receipt);
  } catch (error) {
    await assertFinalizer(receipt);
    receipt.state = 'finalization-failed';
    receipt.finalization!.outcome = 'failed-or-unknown';
    await persist(receipt);
    throw error;
  } finally {
    // Success already removed the lease. On failure, only this generation's
    // owner may release the attempt lock. The lease/evidence stays in place.
    if (!removed) {
      try {
        await assertFinalizer(receipt);
        await rm(join(receipt.directory, `finalizer-${receipt.label}`), { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('REVIEW_FINALIZER_LOCK_RETAINED', error);
      }
    }
  }
}

export async function runReviewSession(receipt: ReviewReceipt, run: typeof runLocalDemo): Promise<void> {
  await run({ reviewWindow: true, stopCommand: receipt.controls.stop, onReady: async resources => {
    receipt.state = 'ready';
    receipt.resources = resources;
    await persist(receipt);
  }, onStopping: async () => {
    receipt.state = 'stopping';
    await persist(receipt);
  } });
}

export async function readReviewStatus(): Promise<ReviewReceipt & { service: string | null }> {
  const receipt = await readReviewReceipt();
  const service = await inspectReviewService(receipt);
  const current = await assertSameReviewLease(receipt);
  return { ...current, state: service === null && current.state === 'ready' ? 'failed' : current.state, service };
}

async function supervise(directory: string): Promise<void> {
  if (directory !== reviewDirectory()) throw Error('Supervisor directory refused');
  const receipt = await readReviewReceipt(directory);
  await assertOwnedService(receipt);
  let cancelled = false;
  const cancel = (): void => { cancelled = true; };
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  process.on('SIGHUP', cancel);
  const checkStop = async (): Promise<void> => {
    if (!cancelled && await reviewStopRequested(receipt)) {
      cancelled = true;
      process.emit('SIGTERM');
    }
  };
  const cancellationPoll = setInterval(() => { void checkStop().catch(error => console.error('REVIEW_STOP_CHECK_FAILED', error)); }, 100);
  let clean = false;
  try {
    receipt.supervisorPid = process.pid;
    await persist(receipt);
    await checkStop();
    const { runLocalDemo } = await import('./localdemo.ts');
    await checkStop();
    if (!cancelled) await runReviewSession(receipt, runLocalDemo);
    clean = true;
  } catch (error) {
    receipt.state = 'failed';
    await persist(receipt);
    console.error('REVIEW_WINDOW_FAILED: retained exact receipt/log for inspection', error);
  } finally {
    clearInterval(cancellationPoll);
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
    process.off('SIGHUP', cancel);
    await beginReviewFinalization(receipt, clean);
  }
}

async function runFinalizer(directory: string, label: string, token: string): Promise<void> {
  if (directory !== reviewDirectory()) throw Error('Finalizer directory refused');
  // Parent persists the spawned PID before handing over receipt custody.
  const deadline = Date.now() + 5000;
  let receipt = await readReviewReceipt(directory);
  while (receipt.label === label && receipt.finalization?.token === token && receipt.finalization.pid === undefined && Date.now() < deadline) {
    await delay(20);
    receipt = await readReviewReceipt(directory);
  }
  if (receipt.label !== label || receipt.finalization?.token !== token) throw Error('Stale finalizer refused');
  await assertFinalizer(receipt);
  const timer = setTimeout(() => { console.error('REVIEW_FINALIZER_DEADLINE: retained lease requires inspection'); process.exit(1); }, Math.max(1, Date.parse(receipt.finalization!.expiresAt) - Date.now()));
  try { await finalizeReviewWindow(receipt); }
  finally { clearTimeout(timer); }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'start') {
    const receipt = await startReviewWindow();
    console.error('REVIEW_WINDOW_STARTED', JSON.stringify(receipt));
    console.error('Start is NOT readiness. Run status until state=ready. Its resources.expiresAt is the exact usable-window expiry. The originating terminal may now exit.');
  } else if (command === 'status') {
    const receipt = await readReviewStatus();
    console.error(JSON.stringify(receipt, null, 2));
    console.error(await readFile(join(receipt.directory, 'runtime.log'), 'utf8'));
  } else if (command === 'stop') await stopReviewWindow();
  else if (command === 'supervise' && process.argv[3]) await supervise(process.argv[3]);
  else if (command === 'finalize' && process.argv[3] && process.argv[4] && process.argv[5]) await runFinalizer(process.argv[3], process.argv[4], process.argv[5]);
  else throw Error('Usage: node --experimental-transform-types scripts/localdemoReviewWindow.ts start|status|stop');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
