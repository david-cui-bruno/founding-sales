import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertOwnedService, checkReviewStart, launchctl, readReviewReceipt, reviewDirectory, reviewPlist, shellQuote, type ReviewReceipt } from './localdemoReviewWindowCore.ts';

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
    // A failed bootstrap can have an unknown outcome. Keep its exact receipt,
    // never erase ownership evidence or kill an unverified PID.
    throw error;
  }
}

export async function stopReviewWindow(): Promise<void> {
  const receipt = await readReviewReceipt();
  await assertOwnedService(receipt);
  await writeFile(join(receipt.directory, 'stop-requested'), '', { mode: 0o600, flag: 'a' });
  // Do not overwrite the supervisor's receipt during its startup/ready transition.
  console.error('REVIEW_WINDOW_STOP_REQUESTED', JSON.stringify({ target: receipt.target, directory: receipt.directory }));
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
    try { await access(join(directory, 'stop-requested')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!cancelled) {
      cancelled = true;
      // Deliver only to this supervisor's installed graceful handlers. The
      // marker survives a stop request before dependency import/handler setup.
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
    if (!cancelled) await runLocalDemo({ reviewWindow: true, stopCommand: receipt.controls.stop, onReady: async resources => {
      receipt.state = 'ready';
      receipt.resources = resources;
      await persist(receipt);
    } });
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
    // Remove the definition only after normal teardown. No KeepAlive, no login
    // item, no persistent agent installation. bootout terminates this supervisor.
    await assertOwnedService(receipt);
    if (clean) await rm(directory, { recursive: true, force: true });
    launchctl(['bootout', receipt.target]);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'start') {
    const receipt = await startReviewWindow();
    console.error('REVIEW_WINDOW_STARTED', JSON.stringify(receipt));
    console.error('Start is NOT readiness. Run status until state=ready. Its resources.expiresAt is the exact usable-window expiry. The originating terminal may now exit.');
  } else if (command === 'status') {
    const receipt = await readReviewReceipt();
    const service = await assertOwnedService(receipt);
    console.error(JSON.stringify({ ...receipt, service }, null, 2));
    console.error(await readFile(join(receipt.directory, 'runtime.log'), 'utf8'));
  } else if (command === 'stop') await stopReviewWindow();
  else if (command === 'supervise' && process.argv[3]) await supervise(process.argv[3]);
  else throw Error('Usage: node --experimental-transform-types scripts/localdemoReviewWindow.ts start|status|stop');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
