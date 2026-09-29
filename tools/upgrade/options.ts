import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

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

/**
 * The path with every symlink resolved, or the path itself when it cannot be resolved.
 *
 * An unresolvable path is not a pass: it simply cannot alias anything either, because
 * nothing on the way to it exists to be a link. The refusal it feeds is about aliases.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
  const evidence = evidenceValue === undefined ? null : resolve(evidenceValue);
  if (evidence !== null) {
    // The evidence is written twice — a stub before the first step, the report at the
    // end — and `--evidence` was unrestricted, so it could name a tracked file in
    // either checkout and overwrite it (GPT-6 review of PR 314, P2). Both checkouts are
    // working trees this run reads its own inputs out of; a run that rewrites its own
    // migration files or its own tool is not evidence of anything. Put it elsewhere.
    //
    // Compared by **canonical** path. A lexical comparison sees only the name it was
    // given, so a symlink sitting outside both checkouts and pointing at a tracked file
    // inside one walked straight past it (GPT-6, third review, P2). `realpath` is taken
    // of the containing directory rather than of the file, because the file is not
    // supposed to exist yet — that is the point of the exclusive create.
    // When the path already exists — which includes a symlink to somewhere else — its
    // own canonical form is the one that matters. When it does not, the containing
    // directory's is: the file is not supposed to exist yet, and a symlinked *directory*
    // aliases just as well as a symlinked file.
    const realEvidence = existsSync(evidence)
      ? canonical(evidence)
      : join(canonical(dirname(evidence)), basename(evidence));
    for (const [what, root] of [['the base checkout', base], ['the head checkout', tree]] as const) {
      const realRoot = canonical(root);
      if (realEvidence === realRoot || realEvidence.startsWith(`${realRoot}/`)) {
        throw new UsageError(
          `--evidence ${evidence} resolves to ${realEvidence}, which is inside ${what} (${realRoot}); write it outside both checkouts, where it cannot overwrite a tracked file`,
        );
      }
    }
  }
  return {
    from,
    to,
    base,
    tree,
    migrations,
    baseMigrations,
    evidence,
    allowRemoteCluster: flags.has('allow-remote-test-cluster'),
  };
}
