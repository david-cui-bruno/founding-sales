import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';
function history(sql: string, hiddenInfra = false) {
  const root = mkdtempSync(join(tmpdir(), 'routine-release-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  mkdirSync(join(root, 'packages/domain/db/migrations'), { recursive: true });
  writeFileSync(join(root, 'packages/domain/db/migrations/0001_first.sql'), 'CREATE TABLE first(id integer);');
  writeFileSync(join(root, 'packages/domain/db/schemaRange.ts'), 'export const REQUIRED_SCHEMA = 1;');
  git('add', '.'); git('commit', '-qm', 'deployed'); const base = git('rev-parse', 'HEAD');
  if (hiddenInfra) {
    mkdirSync(join(root, 'infra'), { recursive: true }); writeFileSync(join(root, 'infra/hidden.tf'), 'resource');
    git('add', '.'); git('commit', '-qm', 'infra changed');
    rmSync(join(root, 'infra/hidden.tf')); git('add', '.'); git('commit', '-qm', 'infra removed');
  }
  writeFileSync(join(root, 'packages/domain/db/migrations/0002_next.sql'), sql);
  writeFileSync(join(root, 'packages/domain/db/schemaRange.ts'), 'export const REQUIRED_SCHEMA = 2;');
  git('add', '.'); git('commit', '-qm', 'next');
  return { root, base, head: git('rev-parse', 'HEAD') };
}
function plan(value: ReturnType<typeof history>, held = false) {
  const result = spawnSync(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', repositoryPath('tools/ci/release-plan.ts'), '--repository', value.root, '--from', value.base, '--to', value.head, ...(held ? ['--held'] : [])], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { decision: string; fromSchema: number; toSchema: number; reasons: string[] };
}
describe('routine release eligibility over deployed history', () => {
  it('admits an additive maintenance migration but preserves an explicit release hold', () => {
    const value = history('CREATE TABLE second(id integer);');
    try { expect(plan(value)).toMatchObject({ decision: 'maintenance', fromSchema: 1, toSchema: 2 }); expect(plan(value, true).decision).toBe('held'); }
    finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('routes destructive, privilege and opaque migration statements to review', () => {
    for (const sql of ['DROP TABLE first;', 'GRANT SELECT ON first TO app_runtime;', 'SELECT mysterious_write();']) {
      const value = history(sql);
      try { expect(plan(value).decision).toBe('reviewed'); } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
  });
  it('sees infrastructure added and removed between the actual deployed build and release', () => {
    const value = history('CREATE TABLE second(id integer);', true);
    try { expect(plan(value).decision).toBe('reviewed'); } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('refuses byte changes in an already deployed migration, including trailing whitespace', () => {
    const value = history('CREATE TABLE second(id integer);');
    try {
      writeFileSync(join(value.root, 'packages/domain/db/migrations/0001_first.sql'), 'CREATE TABLE first(id integer);\n');
      execFileSync('git', ['add', '.'], { cwd: value.root });
      execFileSync('git', ['commit', '-qm', 'checksum changed'], { cwd: value.root });
      value.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: value.root, encoding: 'utf8' }).trim();
      expect(plan(value).decision).toBe('reviewed');
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });

  it('does not recount infrastructure already released when an app branch updates from main', () => {
    const value = history('CREATE TABLE second(id integer);');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: value.root, encoding: 'utf8' }).trim();
    try {
      git('branch', 'app', value.base);
      mkdirSync(join(value.root, 'infra'), { recursive: true });
      writeFileSync(join(value.root, 'infra/released.tf'), 'released');
      git('add', '.'); git('commit', '-qm', 'reviewed infrastructure already released');
      value.base = git('rev-parse', 'HEAD'); const main = git('branch', '--show-current');
      git('checkout', '-q', 'app'); mkdirSync(join(value.root, 'apps/api'), { recursive: true });
      writeFileSync(join(value.root, 'apps/api/change.ts'), 'export {};');
      git('add', '.'); git('commit', '-qm', 'app change');
      git('merge', '-q', '--no-ff', '-m', 'update branch', main);
      git('checkout', '-q', main); git('merge', '-q', '--no-ff', '-m', 'merge application', 'app');
      value.head = git('rev-parse', 'HEAD');
      expect(plan(value).decision).toBe('application');
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });

});
