import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { assertCleanHead, readReleaseMarker, validateReleaseMarker } from './writeReleaseMarker.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = 'Callie Founder Sales System';
const fail = () => { throw new Error('PRE_RELEASE_BACKUP_FAILED'); };
export function validatePreReleaseReceipt(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['basename', 'createdAt', 'kind', 'schemaVersion', 'sha256', 'sizeBytes', 'verifiedAt'])
    || typeof value.basename !== 'string' || !/^pre_release-[0-9]{8}T[0-9]{9}Z\.sqlite3$/.test(value.basename) || value.kind !== 'pre_release' || value.schemaVersion !== 16
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0
    || [value.createdAt, value.verifiedAt].some(time => typeof time !== 'string' || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)) fail();
  return value;
}
export function launchPreReleaseBackup({ args = process.argv.slice(2), env = process.env, run = spawnSync } = {}) {
  if (args.length || process.platform !== 'darwin' || process.arch !== 'arm64' || env.HOME !== userInfo().homedir
    || Object.keys(env).some(name => /^(?:CALLIE_|ELECTRON_|NODE_|DYLD_|XDG_)/.test(name))) fail();
  const marker = readReleaseMarker({ root }); assertCleanHead({ root, expectedSha: marker.commitSha });
  const platformPath = join(root, 'out', `${PRODUCT}-darwin-arm64`);
  const app = join(platformPath, `${PRODUCT}.app`), contents = join(app, 'Contents');
  const executable = join(contents, 'MacOS', PRODUCT), asar = join(contents, 'Resources/app.asar');
  for (const path of [join(root, 'out'), platformPath, app, contents, join(contents, 'MacOS'), join(contents, 'Resources')]) if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail();
  if (readdirSync(platformPath).filter(name => name.endsWith('.app')).length !== 1 || !lstatSync(executable).isFile() || !(lstatSync(executable).mode & 0o100)
    || !lstatSync(asar).isFile() || lstatSync(asar).isSymbolicLink()) fail();
  const execute = (command, commandArgs, timeout = 30_000) => {
    const result = run(command, commandArgs, { cwd: root, env, shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 65_536, timeout });
    if (result.error || result.signal || result.status !== 0) fail(); return result.stdout;
  };
  for (const [key, expected] of [['CFBundleIdentifier', 'com.callie.foundersales'], ['CFBundleName', PRODUCT], ['CFBundleDisplayName', PRODUCT], ['CFBundleExecutable', PRODUCT]]) {
    if (execute('plutil', ['-extract', key, 'raw', '-o', '-', join(contents, 'Info.plist')]).trim() !== expected) fail();
  }
  const embedded = validateReleaseMarker(JSON.parse(extractFile(asar, 'release-marker.json').toString('utf8')));
  if (embedded.commitSha !== marker.commitSha || embedded.builtAt !== marker.builtAt) fail();
  assertCleanHead({ root, expectedSha: marker.commitSha });
  const receipt = validatePreReleaseReceipt(JSON.parse(execute(executable, ['--callie-pre-release-backup'], 900_000)));
  assertCleanHead({ root, expectedSha: marker.commitSha });
  return receipt;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(launchPreReleaseBackup())); }
  catch { console.error('PRE_RELEASE_BACKUP_FAILED'); process.exitCode = 1; }
}
