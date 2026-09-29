import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * What `npm run upgrade:test` was asked to do.
 *
 * `--base` is required and has no default. It names the checkout whose own
 * `REQUIRED_SCHEMA` is N: the migrations 1..N are applied from *its* directory and the
 * fixture is written by *its* code, because the data production already holds was
 * written by the code production is already running. A default here would be a way to
 * accidentally test HEAD against itself.
 */
export interface Options {
  readonly from: number;
  readonly to: number;
  readonly base: string;
  /** The tree under test: HEAD. Its migrations, its constraint cases, its application code. */
  readonly tree: string;
  readonly migrations: string;
  readonly baseMigrations: string;
  readonly evidence: string | null;
  readonly allowRemoteCluster: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const MIGRATIONS_PATH = ['packages', 'domain', 'db', 'migrations'];

export function parseOptions(argv: readonly string[], repositoryRoot: string): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const inline = /^--([a-z-]+)=(.*)$/u.exec(argument);
    if (inline?.[1] !== undefined) {
      values.set(inline[1], inline[2] ?? '');
      continue;
    }
    const flag = /^--([a-z-]+)$/u.exec(argument);
    if (flag?.[1] === undefined) throw new UsageError(`unexpected argument: ${argument}`);
    if (flag[1] === 'allow-remote-test-cluster') {
      flags.add(flag[1]);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) throw new UsageError(`--${flag[1]} needs a value`);
    values.set(flag[1], next);
    index += 1;
  }

  const number = (name: string): number => {
    const raw = values.get(name);
    if (raw === undefined) throw new UsageError(`--${name} is required`);
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`--${name} must be a positive integer`);
    return parsed;
  };
  const from = number('from');
  const to = number('to');
  if (to <= from) throw new UsageError(`--to (${String(to)}) must be greater than --from (${String(from)})`);

  const baseValue = values.get('base');
  if (baseValue === undefined) {
    throw new UsageError(
      '--base <path> is required: the checkout at schema N, whose own migrations build the deployed schema and whose own code writes the fixture.',
    );
  }
  const base = resolve(baseValue);
  const treeValue = values.get('tree');
  const tree = treeValue === undefined ? repositoryRoot : resolve(treeValue);

  const migrationsValue = values.get('migrations');
  const migrations =
    migrationsValue === undefined
      ? join(tree, ...MIGRATIONS_PATH)
      : isAbsolute(migrationsValue)
        ? migrationsValue
        : resolve(migrationsValue);
  const baseMigrations = join(base, ...MIGRATIONS_PATH);
  if (!existsSync(migrations)) throw new UsageError(`no migrations directory at ${migrations}`);
  if (!existsSync(baseMigrations)) throw new UsageError(`no migrations directory at ${baseMigrations}`);

  const evidenceValue = values.get('evidence');
  return {
    from,
    to,
    base,
    tree,
    migrations,
    baseMigrations,
    evidence: evidenceValue === undefined ? null : resolve(evidenceValue),
    allowRemoteCluster: flags.has('allow-remote-test-cluster'),
  };
}
