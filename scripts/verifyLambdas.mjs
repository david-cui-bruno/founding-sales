import { spawnSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function discoverLambdaPackages({ root = projectRoot, run = spawnSync } = {}) {
  const git = run('git', ['ls-files', '-z', '--', 'cloud/lambdas/*/package.json'], { cwd: root, encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 1_048_576 });
  if (git.error || git.signal || git.status !== 0 || (git.stdout && !git.stdout.endsWith('\0'))) throw new Error('LAMBDA_DISCOVERY_FAILED');
  const manifests = [...new Set(git.stdout.split('\0').filter(path => /^cloud\/lambdas\/[a-z0-9-]+\/package\.json$/.test(path)))];
  if (manifests.length === 0) throw new Error('LAMBDA_DISCOVERY_EMPTY');
  return manifests.sort((a, b) => a.localeCompare(b)).map(path => {
    const directory = join(root, dirname(path));
    if (!lstatSync(directory).isDirectory() || !lstatSync(join(root, path)).isFile()) throw new Error('LAMBDA_UNSAFE_PACKAGE');
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'));
    const phases = ['typecheck', 'test', 'build'];
    if (phases.some(phase => typeof manifest.scripts?.[phase] !== 'string' || !manifest.scripts[phase].trim())) throw new Error('LAMBDA_REQUIRED_SCRIPT_MISSING');
    return { directory, phases };
  });
}
export function verifyLambdas({ root = projectRoot, run = spawnSync } = {}) {
  const packages = discoverLambdaPackages({ root, run });
  for (const { directory, phases } of packages) for (const phase of phases) {
    const result = run('npm', ['run', phase], { cwd: directory, shell: false, stdio: 'inherit', timeout: 600_000 });
    if (result.error || result.signal || result.status !== 0) throw new Error('LAMBDA_PHASE_FAILED');
  }
  return packages.length;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 2) throw new Error(); console.log(`Lambda verification passed: ${verifyLambdas()} packages.`); }
  catch { console.error('LAMBDA_VERIFICATION_FAILED'); process.exitCode = 1; }
}
