import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { assertCleanHead, readReleaseMarker, validateReleaseMarker } from './writeReleaseMarker.mjs';

/**
 * `npm run export:cutover` (slice S6). Launches the packaged old app in its third reserved headless mode and
 * prints the report it wrote: the path of the export file, its byte length, its sha256 and the three counts.
 *
 * Nothing here reads the database and nothing here reads the export: the launcher only verifies the packaged host
 * it is about to run (the same identity, marker and clean-head checks `diagnose:startup` performs), hands it a
 * scrubbed environment, and validates the closed-shape report that comes back. The file itself stays where the
 * app wrote it, 0600 in `~/Callie Backups`, for David to read before the import uses it.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = 'Callie Founder Sales System';
const fail = () => { throw new Error('CUTOVER_EXPORT_FAILED'); };
// The packaged host refuses any CALLIE_/ELECTRON_/NODE_/DYLD_/XDG_ variable, exactly as the diagnose host does.
const PASSTHROUGH = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
export function scrubEnvironment(env) {
  const scrubbed = Object.fromEntries(PASSTHROUGH.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
  if (scrubbed.HOME !== userInfo().homedir) fail();
  return scrubbed;
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;
export function validateCutoverExportReport(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['bytes', 'counts', 'kind', 'path', 'phone', 'schemaVersion', 'sha256'])
    || value.kind !== 'cutover_export' || typeof value.path !== 'string' || value.path.length > 4096 || !value.path.startsWith('/')
    || !isCount(value.bytes) || value.bytes <= 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !isCount(value.schemaVersion) || !['confirmed', 'cleared'].includes(value.phone)
    || !value.counts || JSON.stringify(Object.keys(value.counts).sort()) !== JSON.stringify(['callbacks', 'neverCall', 'templates'])
    || !isCount(value.counts.callbacks) || !isCount(value.counts.neverCall) || !isCount(value.counts.templates)) fail();
  return value;
}

export function launchCutoverExport({ args = process.argv.slice(2), env = process.env, run = spawnSync } = {}) {
  if (args.length || process.platform !== 'darwin' || process.arch !== 'arm64') fail();
  const scrubbed = scrubEnvironment(env);
  const marker = readReleaseMarker({ root }); assertCleanHead({ root, expectedSha: marker.commitSha });
  const platformPath = join(root, 'out', `${PRODUCT}-darwin-arm64`);
  const app = join(platformPath, `${PRODUCT}.app`), contents = join(app, 'Contents');
  const executable = join(contents, 'MacOS', PRODUCT), asar = join(contents, 'Resources/app.asar');
  for (const path of [join(root, 'out'), platformPath, app, contents, join(contents, 'MacOS'), join(contents, 'Resources')]) {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail();
  }
  if (readdirSync(platformPath).filter(name => name.endsWith('.app')).length !== 1 || !lstatSync(executable).isFile() || !(lstatSync(executable).mode & 0o100)
    || !lstatSync(asar).isFile() || lstatSync(asar).isSymbolicLink()) fail();
  const execute = (command, commandArgs, timeout = 30_000) => {
    const result = run(command, commandArgs, { cwd: root, env: scrubbed, shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 65_536, timeout });
    if (result.error || result.signal || result.status !== 0) { if (result.stderr) process.stderr.write(String(result.stderr).slice(0, 200)); fail(); }
    return result.stdout;
  };
  for (const [key, expected] of [['CFBundleIdentifier', 'com.callie.foundersales'], ['CFBundleName', PRODUCT], ['CFBundleDisplayName', PRODUCT], ['CFBundleExecutable', PRODUCT]]) {
    if (execute('plutil', ['-extract', key, 'raw', '-o', '-', join(contents, 'Info.plist')]).trim() !== expected) fail();
  }
  const embedded = validateReleaseMarker(JSON.parse(extractFile(asar, 'release-marker.json').toString('utf8')));
  if (embedded.commitSha !== marker.commitSha || embedded.builtAt !== marker.builtAt) fail();
  const report = validateCutoverExportReport(JSON.parse(execute(executable, ['--callie-export-cutover'], 900_000)));
  assertCleanHead({ root, expectedSha: marker.commitSha });
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(launchCutoverExport(), null, 2)); }
  catch { console.error('CUTOVER_EXPORT_FAILED'); process.exitCode = 1; }
}
