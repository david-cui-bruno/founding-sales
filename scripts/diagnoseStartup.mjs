import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { assertCleanHead, readReleaseMarker, validateReleaseMarker } from './writeReleaseMarker.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = 'Callie Founder Sales System';
const fail = () => { throw new Error('STARTUP_DIAGNOSE_FAILED'); };
// The packaged host refuses any CALLIE_/ELECTRON_/NODE_/DYLD_/XDG_ variable.
// Hand it a fixed environment instead of failing on whatever the shell carries.
const PASSTHROUGH = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
export function scrubEnvironment(env) {
  const scrubbed = Object.fromEntries(PASSTHROUGH.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
  if (scrubbed.HOME !== userInfo().homedir) fail();
  return scrubbed;
}
const STAGES = new Set(['open', 'readiness', 'migrate', 'domain']);
const isSize = value => value === null || (Number.isSafeInteger(value) && value >= 0);
const isDetail = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every(entry => (typeof entry === 'number' && Number.isFinite(entry)) || (typeof entry === 'string' && /^[a-z_]{1,40}$/.test(entry)));
export function validateDiagnoseReport(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['copied', 'files', 'kind', 'stages', 'verdict'])
    || value.kind !== 'diagnose_startup' || !value.files || JSON.stringify(Object.keys(value.files).sort()) !== JSON.stringify(['database', 'journal', 'shm', 'wal'])
    || !Number.isSafeInteger(value.files.database) || value.files.database <= 0 || ![value.files.wal, value.files.shm, value.files.journal].every(isSize)
    || !Array.isArray(value.copied) || !value.copied.every(entry => entry === 'database' || entry === 'wal')
    || !Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > 4) fail();
  for (const stage of value.stages) {
    if (!stage || !STAGES.has(stage.stage) || typeof stage.ok !== 'boolean') fail();
    if (stage.ok) { if (!isDetail(stage.detail)) fail(); continue; }
    const failure = stage.failure;
    if (!failure || typeof failure.stage !== 'string' || !/^[a-z]{1,10}$/.test(failure.stage) || typeof failure.errorClass !== 'string' || !/^[A-Za-z]{1,48}$/.test(failure.errorClass)
      || (failure.code !== undefined && !/^[A-Za-z_]{1,48}$/.test(failure.code)) || typeof stage.message !== 'string' || stage.message.length > 240 || /\//.test(stage.message)) fail();
  }
  const failed = value.stages.find(stage => !stage.ok);
  if (value.verdict !== (failed ? `database_failed_${failed.stage}` : 'database_ready')) fail();
  return value;
}
export function launchStartupDiagnose({ args = process.argv.slice(2), env = process.env, run = spawnSync } = {}) {
  if (args.length || process.platform !== 'darwin' || process.arch !== 'arm64') fail();
  const scrubbed = scrubEnvironment(env);
  const marker = readReleaseMarker({ root }); assertCleanHead({ root, expectedSha: marker.commitSha });
  const platformPath = join(root, 'out', `${PRODUCT}-darwin-arm64`);
  const app = join(platformPath, `${PRODUCT}.app`), contents = join(app, 'Contents');
  const executable = join(contents, 'MacOS', PRODUCT), asar = join(contents, 'Resources/app.asar');
  for (const path of [join(root, 'out'), platformPath, app, contents, join(contents, 'MacOS'), join(contents, 'Resources')]) if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail();
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
  const report = validateDiagnoseReport(JSON.parse(execute(executable, ['--callie-diagnose-startup'], 900_000)));
  assertCleanHead({ root, expectedSha: marker.commitSha });
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(launchStartupDiagnose(), null, 2)); }
  catch { console.error('STARTUP_DIAGNOSE_FAILED'); process.exitCode = 1; }
}
