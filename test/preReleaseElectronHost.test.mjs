import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveApplicationPaths } from '../src/main/applicationPaths';
import { openExistingPreReleaseDatabase } from '../src/main/backup/preReleaseBackupRuntime';
import { openDatabase, closeDatabase } from '../src/main/db/database';
import { migrateToLatest } from '../src/main/db/migrate';

// Explicit test coordination only. Production host/launcher accept no such flag.
it.skipIf(process.env.CALLIE_TEST_SYNTHETIC_ELECTRON !== '1')('proves two real synthetic Electron processes share the lock and only its owner writes a verified linked receipt', async () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = realpathSync(mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'task12-electron-')));
  chmodSync(root, 0o700);
  const profile = join(root, 'synthetic-profile'); mkdirSync(profile, { mode: 0o700 });
  const paths = resolveApplicationPaths(profile), key = { bytes: Buffer.alloc(32, 42), version: 1 };
  const children = [];
  const launch = () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CALLIE_|ELECTRON_|NODE_|DYLD_|XDG_)/.test(name)));
    const child = spawn(join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [join(root, 'host.cjs')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { child, messages: [], stderrSeen: false, exited: false, code: null, signal: null, error: false };
    children.push(state);
    let pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      for (;;) { const index = pending.indexOf('\n'); if (index < 0) break; const line = pending.slice(0, index); pending = pending.slice(index + 1); try { state.messages.push(JSON.parse(line)); } catch { state.error = true; } }
      if (pending.length > 8192) { pending = ''; state.error = true; }
    });
    child.stderr.on('data', () => { state.stderrSeen = true; });
    child.on('error', () => { state.error = true; });
    child.on('close', (code, signal) => { state.exited = true; state.code = code; state.signal = signal; });
    return state;
  };
  const until = async (predicate, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!predicate()) { if (Date.now() > end) throw new Error('SYNTHETIC_HOST_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    const database = openDatabase({ path: paths.databasePath, key });
    try { await migrateToLatest(database, { backupDirectory: paths.backupDirectory, workspaceKey: key }); } finally { closeDatabase(database); }
    writeFileSync(paths.keyEnvelopePath, 'synthetic-fixture-envelope', { mode: 0o600 });
    execFileSync(process.execPath, ['scripts/buildOperationalTools.mjs'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    // Only this test host plus the actual import-safe core are loaded. No main,
    // Keychain, real envelope loader, helper, sourcing, network or windows.
    writeFileSync(join(root, 'host.cjs'), `
const { createRequire } = require('node:module');
const load = createRequire(${JSON.stringify(join(repo, 'package.json'))});
const { app } = load('electron');
const core = load(${JSON.stringify(join(repo, 'build/generated/pre-release-tools/preReleaseBackupRuntime.cjs'))});
app.setName(${JSON.stringify('Task12Synthetic-' + randomUUID())});
app.setPath('userData', ${JSON.stringify(profile)});
app.setPath('sessionData', ${JSON.stringify(profile)});
app.setPath('logs', ${JSON.stringify(join(root, 'logs'))});
app.setActivationPolicy('prohibited');
const counts = { paths: 0, keys: 0, opens: 0, closes: 0, unlocks: 0 };
const keys = [];
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
const timeout = setTimeout(() => app.exit(90), 30000);
app.on('second-instance', () => {});
core.performPreReleaseBackup({
 acquireLock: () => app.requestSingleInstanceLock(),
 releaseLock: () => { counts.unlocks++; app.releaseSingleInstanceLock(); },
 ready: async () => { await app.whenReady(); output({ locked: true }); await new Promise((resolve, reject) => { process.stdin.once('data', chunk => chunk.toString() === 'GO\\n' ? resolve() : reject(new Error('CONTROL'))); process.stdin.resume(); }); },
 paths: () => { counts.paths++; return ${JSON.stringify(paths)}; },
 loadKey: async () => { counts.keys++; const key = { bytes: Buffer.alloc(32, 42), version: 1 }; keys.push(key); return key; },
 open: (paths, key) => { counts.opens++; return core.openExistingPreReleaseDatabase(paths, key); },
 close: database => { counts.closes++; database.raw.close(); }
}).then(receipt => { clearTimeout(timeout); process.stdin.pause(); process.stdout.write(JSON.stringify({ success: true, counts, zeroed: keys.every(key => key.bytes.every(byte => byte === 0)), receipt }) + '\\n', () => app.exit(0)); }, () => { clearTimeout(timeout); process.stdin.pause(); process.stdout.write(JSON.stringify({ success: false, counts, zeroed: keys.every(key => key.bytes.every(byte => byte === 0)) }) + '\\n', () => app.exit(1)); });
`, { mode: 0o600 });
    const first = launch(); await until(() => first.messages.some(message => message.locked) || first.exited);
    expect(first.exited).toBe(false); expect(first.error).toBe(false);
    const second = launch(); await until(() => second.exited);
    expect(second.code).toBe(1); expect(second.signal).toBeNull(); expect(second.error).toBe(false);
    expect(second.messages).toEqual([{ success: false, counts: { paths: 0, keys: 0, opens: 0, closes: 0, unlocks: 0 }, zeroed: true }]);
    first.child.stdin.write('GO\n'); await until(() => first.exited, 30_000);
    expect(first.code).toBe(0); expect(first.signal).toBeNull(); expect(first.error).toBe(false);
    const result = first.messages.find(message => message.success);
    expect(result?.counts).toEqual({ paths: 1, keys: 2, opens: 1, closes: 1, unlocks: 1 }); expect(result?.zeroed).toBe(true);
    expect(result?.receipt.schemaVersion).toBe(16);
    const checked = openExistingPreReleaseDatabase(paths, key);
    try { expect(checked.raw.prepare('SELECT backup_basename, kind, schema_version, sha256, size_bytes FROM backup_receipts').all()).toEqual([{ backup_basename: result.receipt.basename, kind: 'pre_release', schema_version: 16, sha256: result.receipt.sha256, size_bytes: result.receipt.sizeBytes }]); } finally { closeDatabase(checked); }
    expect(existsSync(join(paths.backupDirectory, result.receipt.basename))).toBe(true);
    console.log(JSON.stringify({ syntheticElectron: true, ownerExit: first.code, deniedExit: second.code, deniedBeforePathsKeysOpen: true, ownerReceiptLinked: true, keysZeroed: result.zeroed, allExited: children.every(state => state.exited), stderrSeen: children.some(state => state.stderrSeen) }));
  } finally {
    for (const state of children) if (!state.exited) state.child.kill('SIGTERM');
    for (const state of children) if (!state.exited) {
      try { await until(() => state.exited, 2000); } catch { state.child.kill('SIGKILL'); await until(() => state.exited, 5000); }
    }
    key.bytes.fill(0); rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
