import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function trackedSources(output) {
  if (output && !output.endsWith('\0')) throw new Error('LINT_TRACKED_INVALID_GIT_OUTPUT');
  return [...new Set(output.split('\0').filter(Boolean))].filter(path => {
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('LINT_TRACKED_INVALID_PATH');
    return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)
      && !/(^|\/)(?:node_modules|\.vite|out|coverage|test-results|playwright-report|artifacts|\.worktrees)(\/|$)/.test(path)
      && !/^cloud\/lambdas\/[^/]+\/dist\//.test(path)
      && !/^build\/generated\//.test(path)
      && !/^native\/(?:safe-log-fs\/build|apple-bridge\/\.build)\//.test(path);
  }).sort();
}
export function lintTracked({ root = projectRoot, run = spawnSync } = {}) {
  const git = run('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  if (git.error || git.signal || git.status !== 0) throw new Error('LINT_TRACKED_GIT_FAILED');
  const files = trackedSources(git.stdout);
  if (!files.length) throw new Error('LINT_TRACKED_NO_SOURCES');
  // Bound both count and bytes, not just count (filenames can be long).
  let batch = [], bytes = 0;
  const flush = () => {
    const result = run(process.execPath, [join(root, 'node_modules/eslint/bin/eslint.js'), '--no-ignore', '--max-warnings', '0', '--', ...batch], { cwd: root, shell: false, stdio: 'inherit', timeout: 300_000 });
    if (result.error || result.signal || result.status !== 0) throw new Error('LINT_TRACKED_ESLINT_FAILED');
    batch = []; bytes = 0;
  };
  for (const file of files) {
    const size = Buffer.byteLength(file) + 1;
    if (size > 24_000) throw new Error('LINT_TRACKED_PATH_TOO_LONG');
    if (batch.length && (batch.length >= 100 || bytes + size > 24_000)) flush();
    batch.push(file); bytes += size;
  }
  if (batch.length) flush();
  return files.length;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 2) throw new Error(); const count = lintTracked(); console.log(`Tracked lint passed: ${count} JS/TS files.`); }
  catch { console.error('LINT_TRACKED_FAILED'); process.exitCode = 1; }
}
