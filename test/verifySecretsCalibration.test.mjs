import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPackage } from '@electron/asar';
import { expect, it } from 'vitest';
import { scanWithGitleaks, verifySecrets } from '../scripts/verifySecrets.mjs';

// Hex-only random controls can fall below the default detector's entropy floor.
// Public deterministic seeds produce unissued alphanumeric controls above 4.5.
const syntheticPat = label => 'ghp_' + createHash('sha256').update(`Task12 unissued fixture ${label}`).digest('base64').replace(/[+/]/g, 'x').slice(0, 36);

it('disposes only the exact full source span, path and generic rule with real pinned Gitleaks', () => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'gitleaks-span-'));
  const exactPath = 'cloud/scripts/bootstrap-terraform-state.sh';
  const shape = 'kms_key_arn=""\nbucket_phase="absent"\n';
  const fabricated = randomBytes(24).toString('base64url');
  const candidate = readFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8');
  let invocation = 0;
  const scan = (config, file, contents) => {
    const target = join(root, `case-${invocation++}`), temporary = join(root, `report-${invocation}`);
    mkdirSync(join(target, file, '..'), { recursive: true, mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    writeFileSync(join(target, file), contents, { mode: 0o600 }); writeFileSync(join(root, '.gitleaks.toml'), config);
    let rules = [];
    const run = (command, args, options) => {
      const result = spawnSync(command, args, options);
      const report = args[args.indexOf('--report-path') + 1];
      if (report) rules = JSON.parse(readFileSync(report, 'utf8')).map(item => item.RuleID);
      return result;
    };
    const result = scanWithGitleaks({ root, target, kind: 'context', temporary, run });
    return { ...result, rules };
  };
  try {
    expect(execFileSync('gitleaks', ['version'], { encoding: 'utf8' }).trim()).toBe('8.30.1');
    for (const padding of ['', '\n'.repeat(20), '# synthetic\n'.repeat(22)]) {
      expect(scan('[extend]\nuseDefault = true\n', exactPath, padding + shape).findings).toBe(1);
      expect(scan(candidate, exactPath, padding + shape).findings).toBe(0);
      expect(scan(candidate, exactPath, padding + shape.replace('absent', fabricated)).rules).toContain('generic-api-key');
    }
    for (const contents of [
      `kms_key_arn="${fabricated}"\n`,
      shape + `api_key="${fabricated}"\n`,
      `api_key="${fabricated}"\n` + shape,
      shape.replace('"absent"', `"absent"; api_key="${fabricated}"`),
      shape.replace('absent', 'unknown'), shape.replace(/\n/g, '\r\n'),
    ]) expect(scan(candidate, exactPath, contents).rules).toContain('generic-api-key');
    for (const path of ['other.sh', `nested/${exactPath}`, `${exactPath}.bak`]) {
      expect(scan(candidate, path, shape).rules).toContain('generic-api-key');
    }
    const pat = syntheticPat('other-rule');
    expect(scan(candidate, exactPath, shape + `token="${pat}"\n`).rules).toContain('github-pat');
    const otherRule = '\n[[rules]]\nid="synthetic-span-control"\ndescription="Synthetic independent span control"\nregex=\'\'\'kms_key_arn=""\'\'\'\n';
    expect(scan(candidate + otherRule, exactPath, shape).rules).toContain('synthetic-span-control');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
it('disposes only the exact public detector line without recursive or unknown-content exemptions', () => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'gitleaks-public-regex-'));
  const candidate = readFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8');
  const baseline = candidate.split('# Exact pinned public detector definition')[0];
  const publicLine = candidate.match(/id = "aws-amazon-bedrock-api-key-short-lived"\n[^\n]*\n(regex = [^\n]*)/)[1];
  const encoded = [...Buffer.from(publicLine)].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('');
  const sameRule = 'aws-amazon-bedrock-api-key-short-lived';
  const fabricated = publicLine.slice("regex = '''".length, -3) + '-unissued-' + randomBytes(24).toString('hex');
  let invocation = 0;
  const scan = (config, file, contents) => {
    const target = join(root, `case-${invocation++}`), temporary = join(root, `report-${invocation}`);
    mkdirSync(join(target, file, '..'), { recursive: true, mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    writeFileSync(join(target, file), contents, { mode: 0o600 }); writeFileSync(join(root, '.gitleaks.toml'), config);
    let rules = [];
    const run = (command, args, options) => {
      const result = spawnSync(command, args, options);
      rules = JSON.parse(readFileSync(args[args.indexOf('--report-path') + 1], 'utf8')).map(item => item.RuleID);
      return result;
    };
    return { ...scanWithGitleaks({ root, target, kind: 'context', temporary, run }), rules };
  };
  try {
    for (const padding of ['', '\n'.repeat(20), '# synthetic\n'.repeat(22)]) {
      expect.soft(scan(baseline, '.gitleaks.toml', padding + publicLine + '\n').rules).toContain(sameRule);
      expect.soft(scan(candidate, '.gitleaks.toml', padding + publicLine + '\n').findings).toBe(0);
    }
    expect.soft(scan(candidate, '.gitleaks.toml', candidate).findings).toBe(0);
    const withoutLeadingLf = candidate.replace(`\\A\\n?${encoded}`, `\\A${encoded}`);
    expect.soft(scan(withoutLeadingLf, '.gitleaks.toml', '# synthetic\n'.repeat(22) + publicLine + '\n').rules).toContain(sameRule);
    for (const contents of [
      publicLine + ' # changed\n', publicLine.replace('regex =', 'changed =') + '\n', publicLine + '\r\n',
      `token="${fabricated}"\n`, publicLine + `\ntoken="${fabricated}"\n`,
      `token="${fabricated}"\n` + publicLine + '\n', publicLine + `; token="${fabricated}"\n`,
    ]) expect.soft(scan(candidate, '.gitleaks.toml', contents).rules).toContain(sameRule);
    for (const path of ['other.toml', 'nested/.gitleaks.toml', '.gitleaks.toml.bak']) {
      expect.soft(scan(candidate, path, publicLine + '\n').rules).toContain(sameRule);
    }
    expect.soft(scan(candidate, '.gitleaks.toml', publicLine + `\ntoken="${syntheticPat('other-rule')}"\n`).rules).toContain('github-pat');
    const otherRule = '\n[[rules]]\nid="synthetic-public-regex-control"\ndescription="Independent exact-line control"\nregex=\'\'\'regex = \'\'\'\n';
    expect.soft(scan(candidate + otherRule, '.gitleaks.toml', publicLine + '\n').rules).toContain('synthetic-public-regex-control');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
it('calibrates real 8.30.1 on deleted generated-path and merge-only history plus built and extracted content', async () => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'gitleaks-calibration-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  const put = (name, contents) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), contents); };
  const sentinel = label => `token = "${syntheticPat(label)}"`;
  const historyPaths = [
    'node_modules/deleted.js', 'vendor/github.com/fixture/deleted.go',
    'bower_components/deleted.js', '.vite/build/jquery.min.js',
    'nested/package-lock.json', 'nested/gitleaks.toml', 'out/helper.bin',
    'out/help.pdf', 'venv/lib/fixture.py', 'vendor/ruby/fixture.rb',
  ];
  const metadata = [];
  const run = (command, args, options) => {
    const result = spawnSync(command, args, options);
    if (command === 'gitleaks' && args.includes('--report-path')) {
      const findings = JSON.parse(readFileSync(args[args.indexOf('--report-path') + 1], 'utf8'));
      metadata.push(...findings.map(({ File, Commit, RuleID }) => ({ File, Commit, RuleID })));
    }
    return result;
  };
  try {
    git('init', '-b', 'main'); cpSync(new URL('../.gitleaks.toml', import.meta.url), join(root, '.gitleaks.toml')); put('src/clean.js', 'export const n = 1;');
    put('.gitignore', 'node_modules/\nout/\n.vite/\nvendor/\nbower_components/\nvenv/\n');
    put('cloud/scripts/bootstrap-terraform-state.sh', '# synthetic\n'.repeat(22) + 'kms_key_arn=""\nbucket_phase="absent"\n');
    git('add', '.'); git('commit', '-m', 'clean');
    expect(verifySecrets({ root }).map(result => result.status)).toEqual(['passed', 'passed']);
    for (const path of historyPaths) put(path, sentinel('deleted'));
    git('add', '-f', ...historyPaths); git('commit', '-m', 'synthetic history');
    const deletedIntroduction = git('rev-parse', 'HEAD').toString().trim();
    for (const path of historyPaths) expect(git('show', `${deletedIntroduction}:${path}`).toString()).toBe(sentinel('deleted'));
    git('rm', ...historyPaths); git('commit', '-m', 'delete synthetic');
    git('checkout', '-b', 'side'); put('side.txt', 'side'); git('add', '.'); git('commit', '-m', 'side'); git('checkout', 'main'); put('main.txt', 'main'); git('add', '.'); git('commit', '-m', 'main');
    git('merge', '--no-ff', '--no-commit', 'side'); put('out/merge-only.js', sentinel('merge')); git('add', '-f', 'out/merge-only.js'); git('commit', '-m', 'merge synthetic');
    const mergeIntroduction = git('rev-parse', 'HEAD').toString().trim();
    git('rm', 'out/merge-only.js'); git('commit', '-m', 'delete merge synthetic');
    put('.vite/build/main.js', sentinel('generated'));
    put('.vite/build/jquery.min.js', sentinel('generated'));
    const source = verifySecrets({ root, run }); expect(source[0].findings).toBeGreaterThanOrEqual(2); expect(source[1].findings).toBeGreaterThanOrEqual(1);
    expect(git('log', '--all', '--full-history', '-m', '--format=%H').toString().split('\n')).toContain(deletedIntroduction);
    for (const path of historyPaths) expect(metadata).toContainEqual({ File: path, Commit: deletedIntroduction, RuleID: 'github-pat' });
    expect(metadata).toContainEqual({ File: 'out/merge-only.js', Commit: mergeIntroduction, RuleID: 'github-pat' });
    for (const path of ['.vite/build/main.js', '.vite/build/jquery.min.js']) {
      expect(metadata).toContainEqual({ File: path, Commit: '', RuleID: 'github-pat' });
    }
    put('archive/inside.js', sentinel('archive')); put('archive/node_modules/dependency.js', sentinel('archive'));
    const resources = join(root, 'out/Callie.app/Contents/Resources'); mkdirSync(resources, { recursive: true });
    await createPackage(join(root, 'archive'), join(resources, 'app.asar'));
    put('out/Callie.app/Contents/Resources/app.asar.unpacked/module.node', sentinel('archive'));
    put('out/Callie.app/Contents/Helpers/helper.bin', sentinel('archive'));
    expect(verifySecrets({ root, mode: 'package', run })[0].findings).toBeGreaterThanOrEqual(1);
    for (const path of ['asar/inside.js', 'asar/node_modules/dependency.js', 'bundle/Contents/Resources/app.asar.unpacked/module.node', 'bundle/Contents/Helpers/helper.bin']) {
      expect(metadata).toContainEqual({ File: path, Commit: '', RuleID: 'github-pat' });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
