import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAll, listPackage, statFile } from '@electron/asar';
import { selectPackagedApp } from './verifyPackage.mjs';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = () => { throw new Error('SECRET_VERIFICATION_FAILED'); };
const safeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GITLEAKS_|GIT_)/.test(key)));
function execute(command, args, root, run) {
  return run(command, args, { cwd: root, env: safeEnv(), shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 660_000 });
}
function checked(command, args, root, run) {
  const result = execute(command, args, root, run);
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') fail();
  return result.stdout;
}
const within = (parent, child) => { const path = relative(parent, child); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
function privateDirectory(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
function copyTree(source, destination, boundary, allowInternalLinks = false) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    // Framework aliases are covered by their real target in this same bundle.
    if (!allowInternalLinks || !within(boundary, realpathSync(source))) fail();
    return 0;
  }
  if (stat.isDirectory()) {
    privateDirectory(destination);
    return readdirSync(source).reduce((count, name) => count + copyTree(join(source, name), join(destination, name), boundary, allowInternalLinks), 0);
  }
  if (!stat.isFile() || stat.nlink < 1) fail();
  privateDirectory(dirname(destination)); copyFileSync(source, destination); chmodSync(destination, 0o600); return 1;
}
function assertSourcePath(root, path) {
  if (!path || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '')) fail();
  let current = root;
  for (const part of path.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) fail(); }
}
export function stageBuildContext(root, destination, run = spawnSync) {
  const tracked = checked('git', ['ls-files', '-z'], root, run);
  if (tracked && !tracked.endsWith('\0')) fail();
  let count = 0;
  for (const path of tracked.split('\0').filter(Boolean)) {
    // Directory selection only. These exclusions NEVER apply to Git history.
    if (/(^|\/)(?:node_modules|out|\.vite|\.git|\.worktrees|\.superpowers|coverage|artifacts|test-results|playwright-report)(\/|$)/.test(path)
      || /^build\/generated\//.test(path) || /^native\/.*\/(?:build|\.build)\//.test(path)
      || /(?:\.tfstate(?:\.|$)|\.tfvars$|\.sqlite3?(?:\.|$)|\.key-envelope\.json$|(^|\/)\.env(?:\.|$))/.test(path)) continue;
    assertSourcePath(root, path); count += copyTree(join(root, path), join(destination, path), root);
  }
  const generated = ['.vite/build', '.vite/renderer', 'build/generated/operational-tools', 'build/generated/pre-release-tools'];
  const lambdas = join(root, 'cloud/lambdas');
  if (existsSync(lambdas)) for (const name of readdirSync(lambdas)) if (/^[a-z0-9-]+$/.test(name)) generated.push(`cloud/lambdas/${name}/dist`);
  for (const path of generated) if (existsSync(join(root, path))) { assertSourcePath(root, path); count += copyTree(join(root, path), join(destination, path), root); }
  if (!count) fail(); return count;
}
export function stagePackage(root, destination, outDirectory = join(root, 'out')) {
  const app = selectPackagedApp(resolve(root, outDirectory));
  const asar = join(app, 'Contents/Resources/app.asar');
  const unpacked = join(app, 'Contents/Resources/app.asar.unpacked');
  if (!lstatSync(unpacked).isDirectory() || !lstatSync(join(app, 'Contents/Helpers')).isDirectory()) fail();
  const entries = listPackage(asar);
  if (!entries.length) fail();
  for (const entry of entries) {
    const name = entry.replace(/^\//, '');
    if (!name || name.split('/').includes('..') || isAbsolute(name) || statFile(asar, name, false).link) fail();
  }
  privateDirectory(join(destination, 'asar'));
  extractAll(asar, join(destination, 'asar'));
  // Recopy through the checked walker to enforce private modes and reject links.
  copyTree(join(destination, 'asar'), join(destination, 'checked-asar'), destination);
  rmSync(join(destination, 'checked-asar'), { recursive: true });
  const count = copyTree(app, join(destination, 'bundle'), app, true);
  // Scanning the opaque archive is redundant, not a substitute for extraction.
  rmSync(join(destination, 'bundle/Contents/Resources/app.asar'));
  return count;
}
export function scanWithGitleaks({ root, target, kind, temporary, run = spawnSync }) {
  let cwd = root, input = target;
  if (kind !== 'history') {
    const directory = resolve(root, target), stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) fail();
    // Preserve repository-relative detector paths without widening allowlists.
    // Only the already staged private directory becomes the scanner's cwd.
    cwd = realpathSync(directory); input = '.';
  }
  const report = resolve(temporary, `${kind}.json`);
  writeFileSync(report, '', { mode: 0o600, flag: 'wx' });
  const ignore = resolve(temporary, 'empty-ignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '', { mode: 0o600, flag: 'wx' });
  // Gitleaks can exit 0 with partial results when its own deadline expires.
  // Disable it and rely on execute's finite, checked parent error/signal timeout.
  const args = [kind === 'history' ? 'git' : 'dir', '--redact=100', '--no-banner', '--no-color', '--config', resolve(root, '.gitleaks.toml'), '--ignore-gitleaks-allow', '--gitleaks-ignore-path', ignore, '--report-format', 'json', '--report-path', report, '--max-target-megabytes', '0', '--max-archive-depth', '5', '--max-decode-depth', '5', '--timeout', '0', ...(kind === 'history' ? ['--log-opts=--all --full-history -m'] : []), input];
  const result = execute('gitleaks', args, cwd, run);
  if (result.error || result.signal || ![0, 1].includes(result.status)) fail();
  const findings = JSON.parse(readFileSync(report, 'utf8'));
  if (!Array.isArray(findings) || findings.some(item => !item || typeof item.RuleID !== 'string')) fail();
  if ((result.status === 1) !== (findings.length > 0)) fail();
  // Never emit findings, paths, snippets, arbitrary rule names or tool stderr.
  return { kind, status: findings.length ? 'findings' : 'passed', findings: findings.length };
}
export function verifySecrets({ root = projectRoot, mode = 'source', outDirectory = join(root, 'out'), run = spawnSync } = {}) {
  if (!['source', 'package'].includes(mode)) fail();
  if (checked('gitleaks', ['version'], root, run).trim() !== '8.30.1') fail();
  const temporary = mkdtempSync(join(tmpdir(), 'callie-secret-scan-')); chmodSync(temporary, 0o700);
  const results = [];
  try {
    const stage = join(temporary, 'input'); privateDirectory(stage);
    if (mode === 'source') {
      if (checked('git', ['rev-parse', '--is-shallow-repository'], root, run).trim() !== 'false') fail();
      results.push(scanWithGitleaks({ root, target: root, kind: 'history', temporary, run }));
      const files = stageBuildContext(root, stage, run);
      results.push({ ...scanWithGitleaks({ root, target: stage, kind: 'context', temporary, run }), files });
    } else {
      const files = stagePackage(root, stage, outDirectory);
      results.push({ ...scanWithGitleaks({ root, target: stage, kind: 'package', temporary, run }), files });
    }
    return results;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 4 || (process.argv[2] !== undefined && process.argv[2] !== '--package')) fail();
    const results = verifySecrets({ mode: process.argv[2] === '--package' ? 'package' : 'source', outDirectory: resolve(projectRoot, process.argv[3] ?? 'out') });
    console.log(JSON.stringify({ scanner: 'gitleaks-8.30.1', results }));
    if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
  } catch { console.error('SECRET_VERIFICATION_FAILED'); process.exitCode = 1; }
}
