import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyMigration } from '../upgrade/classify.ts';
const args = process.argv.slice(2);
function argument(name: string): string {
  const value = args[args.indexOf(name) + 1];
  if (!args.includes(name) || value === undefined) throw new Error(`Missing ${name}`);
  return value;
}
const repository = argument('--repository');
const from = argument('--from');
const to = argument('--to');
if (![from, to].every(value => /^[0-9a-f]{40}$/u.test(value))) throw new Error('Full observed build commits required');
const git = (...values: string[]): string => execFileSync('git', values, { cwd: repository, encoding: 'utf8', maxBuffer: 10_000_000 }).trim();
git('merge-base', '--is-ancestor', from, to);
const schemaFile = 'packages/domain/db/schemaRange.ts';
function schema(commit: string): number {
  const match = /export const REQUIRED_SCHEMA = (\d+);/u.exec(git('show', `${commit}:${schemaFile}`));
  if (match?.[1] === undefined) throw new Error('Source schema unavailable');
  return Number(match[1]);
}
const fromSchema = schema(from), toSchema = schema(to);
// Every new non-merge commit, plus mainline merge resolutions. Diffs against a
// stale branch parent can otherwise recount already released infrastructure.
const commits = [...git('rev-list', '--reverse', '--no-merges', `${from}..${to}`).split('\n'), ...git('rev-list', '--reverse', '--first-parent', '--merges', `${from}..${to}`).split('\n')].filter(Boolean);
const paths = new Set<string>();
for (const commit of commits) for (const path of git('diff-tree', '--root', '--diff-merges=first-parent', '--no-commit-id', '--name-only', '-r', '--no-renames', commit).split('\n').filter(Boolean)) paths.add(path);
const reasons: string[] = [];
for (const path of paths) {
  if (path === schemaFile || /^packages\/domain\/db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u.test(path)) continue;
  if (/^(infra\/|\.github\/|tools\/ci\/|tools\/upgrade\/)/u.test(path) || path === '.gitattributes' || ['packages/domain/db/migrationRunner.ts', 'packages/domain/db/queryable.ts', 'scripts/productionSmoke.mjs'].includes(path)) reasons.push(`reviewed infrastructure/guard change: ${path}`);
  else if (!/^(apps\/|packages\/|scripts\/|docs\/|test\/|tests\/|certs\/)/u.test(path) && !/^(Dockerfile\.(api|worker)(\.dockerignore)?|package(-lock)?\.json|tsconfig.*\.json|eslint.*\.mjs|README\.md|AGENTS\.md|CLAUDE\.md)$/u.test(path)) reasons.push(`unknown release path: ${path}`);
}
if (toSchema < fromSchema) reasons.push('schema rollback is not automatic');
const work = mkdtempSync(join(tmpdir(), 'fss-release-classify-'));
const migrations: { file: string; kind: string }[] = [];
try {
  const directory = join(work, 'migrations'); mkdirSync(directory);
  const names = git('ls-tree', '-r', '--name-only', to, '--', 'packages/domain/db/migrations').split('\n').filter(Boolean);
  const oldNames = git('ls-tree', '-r', '--name-only', from, '--', 'packages/domain/db/migrations').split('\n').filter(Boolean);
  for (const name of oldNames) if (Number(name.split('/').at(-1)?.slice(0, 4)) <= fromSchema && !names.includes(name)) reasons.push(`deployed migration removed: ${name}`);
  for (const name of names) {
    const file = name.split('/').at(-1);
    if (file === undefined || !/^\d{4}_[a-z0-9_]+\.sql$/u.test(file)) { reasons.push(`unknown migration path: ${name}`); continue; }
    writeFileSync(join(directory, file), execFileSync('git', ['show', `${to}:${name}`], { cwd: repository, maxBuffer: 10_000_000 }));
    const version = Number(file.slice(0, 4));
    if (version <= fromSchema) {
      if (git('rev-parse', `${from}:${name}`) !== git('rev-parse', `${to}:${name}`)) reasons.push(`deployed migration changed: ${name}`);
    }
  }
  for (let version = fromSchema + 1; version <= toSchema; version++) {
    const matching = names.filter(name => Number(name.split('/').at(-1)?.slice(0, 4)) === version);
    if (matching.length !== 1) { reasons.push(`missing or duplicate migration ${version}`); continue; }
    const file = matching[0]?.split('/').at(-1);
    if (file === undefined) throw new Error('Migration unavailable');
    const result = classifyMigration(join(directory, file));
    migrations.push({ file, kind: result.kind });
    if (!['additive', 'replaces-routine'].includes(result.kind) || result.hasUnclassified || result.decisions.some(decision => ['privilege', 'destructive', 'touches-existing', 'unclassified'].includes(decision.kind))) reasons.push(`reviewed migration: ${file} (${result.kind})`);
  }
} finally { rmSync(work, { recursive: true, force: true }); }
process.stdout.write(JSON.stringify({ decision: args.includes('--held') ? 'held' : reasons.length ? 'reviewed' : toSchema > fromSchema ? 'maintenance' : 'application', from, to, fromSchema, toSchema, paths: [...paths].sort(), migrations, reasons }) + "\n");
