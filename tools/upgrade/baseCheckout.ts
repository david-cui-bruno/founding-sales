import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The checkout whose code loads the fixture.
 *
 * The fixture is the data production already holds, so it has to be written by the
 * code production is already running — the commit at schema N. HEAD's commands know
 * schema M: they insert into columns that do not exist yet, read tables that are not
 * there, and the "representative existing data" would quietly become whatever subset
 * of itself the new code could still write. That is the failure this two-checkout
 * arrangement exists to prevent, and the part report is what makes it visible
 * (`main.ts` fails the run on a skipped part).
 *
 * So the loader runs as a child process with its working directory in the base
 * checkout, against that checkout's own `packages/domain`, and it is handed a
 * connection URL in the environment rather than on the command line — an argument list
 * is visible in `ps` and ends in a shell history file, which is the same reason
 * `fss admin database-users ensure` names an environment variable rather than taking a
 * password.
 *
 * ## Two things have to be arranged for that child to be able to run at all
 *
 * **Third-party modules, and whose they are.** A base checkout created with
 * `git worktree add` has no `node_modules`. When the two checkouts' `package-lock.json`
 * are byte-identical, a link farm is built instead of a second install: every entry of
 * HEAD's `node_modules` symlinked, **except** `@fss`, whose workspace packages are
 * symlinked into the *base* tree, so the child gets the base's own first-party code.
 * When the locks differ, the link farm would be a lie — HEAD's third-party versions
 * running under the base's code could produce data the base image never could (GPT-6
 * review, P1-6) — so `npm ci` is run in the base worktree instead and the report says
 * which of the two happened.
 *
 * A `node_modules` that is already there is **not** trusted for being there. It was,
 * and a left-over tree from an earlier run at another commit — or a developer's own
 * `npm install` — was then used silently, which is exactly the lie the lockfile
 * comparison exists to prevent (GPT-6 review of PR 314, P1-6). Whenever this tool
 * builds one it stamps it with the digest of the lockfile it was built from. On the
 * next run: a matching stamp is reused; a stamp that disagrees means our own tree has
 * gone stale, so it is removed and rebuilt; no stamp at all means the directory is
 * somebody else's and the run refuses rather than deleting it.
 *
 * **The loader itself.** Every commit before this lane merged has no
 * `tools/upgrade/`, which includes the first pull request this job runs on. For those,
 * HEAD's `tools/upgrade/` is copied in, removed again afterwards, and never committed;
 * the base's own loader is preferred whenever it has one, because after this merges the
 * loader at N is the one that was written against schema N.
 *
 * Nothing here writes a tracked file, and `cleanup` removes only what it created.
 */

/** The workspace packages a link farm repoints at the base tree. */
const WORKSPACE_PACKAGES: readonly (readonly [string, string])[] = [
  ['contracts', 'packages/contracts'],
  ['domain', 'packages/domain'],
  ['api', 'apps/api'],
  ['worker', 'apps/worker'],
  ['desktop', 'apps/desktop'],
];

export type ModulesSource =
  | 'already present'
  | "reused (that checkout's own npm install, agreeing with its lockfile)"
  | 'reused (stamped with this lockfile)'
  | 'rebuilt (the stamp named another lockfile)'
  | 'linked from HEAD (identical lockfile)'
  | 'npm ci in the base worktree (lockfiles differ)';

/**
 * Where the provenance stamp lives. Not `node_modules/.package-lock.json` — npm's
 * hidden lockfile is a different document from `package-lock.json`, so the two cannot
 * be compared by digest, and a link farm has no hidden lockfile at all. This file says
 * one thing only: the sha256 of the `package-lock.json` the directory was built from.
 */
const STAMP = ['node_modules', '.fss-upgrade-lockfile'] as const;

export interface BaseCheckout {
  readonly directory: string;
  /** `REQUIRED_SCHEMA` as this checkout declares it. */
  readonly schemaVersion: number;
  /** The loader entry point to run, absolute. */
  readonly loader: string;
  /** The post-upgrade checks entry point in this checkout, absolute. */
  readonly checks: string;
  /** True when HEAD's `tools/upgrade` was copied in because the base had none. */
  readonly copiedLoader: boolean;
  /** Where the base checkout's third-party modules came from. */
  readonly modules: ModulesSource;
  cleanup(): Promise<void>;
}

const REQUIRED_SCHEMA_LINE = /^export const REQUIRED_SCHEMA = (\d+);$/mu;

/** The older name, kept because the base checkout is what it is mostly used for. */
export const prepareBaseCheckout = prepareCheckout;

/** `REQUIRED_SCHEMA` out of a checkout's own copy of the file, never out of memory. */
export async function schemaVersionOf(checkout: string): Promise<number> {
  const path = join(checkout, 'packages', 'domain', 'db', 'schemaRange.ts');
  if (!existsSync(path)) throw new Error(`${checkout} has no packages/domain/db/schemaRange.ts`);
  const match = REQUIRED_SCHEMA_LINE.exec(await readFile(path, 'utf8'));
  if (match?.[1] === undefined) throw new Error(`${path} declares no REQUIRED_SCHEMA`);
  return Number(match[1]);
}

/** The sha256 of a checkout's lockfile, or null when it has none. */
async function lockfileDigest(checkout: string): Promise<string | null> {
  const path = join(checkout, 'package-lock.json');
  if (!existsSync(path)) return null;
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** `npm ci` in `checkout`, with the flags the greenfield gate uses. */
/** The lockfile digest a previously built `node_modules` was stamped with, if ours. */
async function readStamp(checkout: string): Promise<string | null> {
  try {
    return (await readFile(join(checkout, ...STAMP), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function writeStamp(checkout: string, digest: string | null): Promise<void> {
  await writeFile(join(checkout, ...STAMP), `${digest ?? 'no package-lock.json'}\n`, 'utf8');
}

/**
 * Whether a `node_modules` this tool did not build was installed from the checkout's
 * own `package-lock.json`, according to npm's hidden lockfile.
 *
 * The two documents are not comparable by digest — the hidden lockfile is npm's own
 * resolution of the real one and legitimately omits entries (optional dependencies for
 * other platforms, for instance: 75 of 565 in this repository's tree). What cannot
 * legitimately differ is a *version*. A disagreeing one, or no hidden lockfile at all,
 * means the directory came from somewhere else.
 *
 * Returns the sentence naming the problem, or `null` when it agrees.
 */
async function hiddenLockfileDisagreement(checkout: string): Promise<string | null> {
  let hidden: unknown;
  let real: unknown;
  try {
    hidden = JSON.parse(await readFile(join(checkout, 'node_modules', '.package-lock.json'), 'utf8'));
    real = JSON.parse(await readFile(join(checkout, 'package-lock.json'), 'utf8'));
  } catch {
    return 'it carries no node_modules/.package-lock.json, so nothing says where it came from';
  }
  const hiddenPackages = (hidden as { packages?: Record<string, { version?: string }> }).packages ?? {};
  const realPackages = (real as { packages?: Record<string, { version?: string; link?: boolean }> }).packages ?? {};
  let compared = 0;
  let wanted = 0;
  for (const [name, entry] of Object.entries(realPackages)) {
    if (name === '' || entry.link === true) continue;
    wanted += 1;
    const installed = hiddenPackages[name];
    if (installed === undefined) continue;
    compared += 1;
    if (installed.version !== entry.version) {
      return `${name} is ${installed.version ?? 'unknown'} there and ${entry.version ?? 'unknown'} in the lockfile`;
    }
  }
  // An overlap this small is not an install of this lockfile at all — more likely a
  // link farm an interrupted run left behind.
  if (wanted > 0 && compared * 2 < wanted) {
    return `only ${String(compared)} of its ${String(wanted)} packages are accounted for`;
  }
  return null;
}

async function install(checkout: string): Promise<void> {
  const code = await new Promise<number | null>(resolve => {
    const child = spawn('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: checkout,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('error', () => { resolve(-1); });
    child.on('close', value => { resolve(value); });
  });
  if (code !== 0) throw new Error(`npm ci in ${checkout} exited ${String(code)}`);
}

async function buildLinkFarm(base: string, head: string): Promise<void> {
  const modules = join(base, 'node_modules');
  await mkdir(modules);
  for (const entry of await readdir(join(head, 'node_modules'))) {
    if (entry === '@fss') continue;
    await symlink(join(head, 'node_modules', entry), join(modules, entry));
  }
  await mkdir(join(modules, '@fss'));
  for (const [name, path] of WORKSPACE_PACKAGES) {
    const target = join(base, path);
    if (!existsSync(target)) continue;
    await symlink(target, join(modules, '@fss', name));
  }
}

/**
 * Make a checkout runnable as a child of this process.
 *
 * Used for both of them. The **base** checkout runs the fixture loader and the previous
 * images' startup check; the **target** checkout runs the post-upgrade startup, registry
 * and workflows. Neither needs anything of this process but its `tools/upgrade`
 * directory and a resolvable `node_modules`, and a checkout that already has both — the
 * ordinary case in CI, where the target is this checkout — is left exactly as it is.
 */
export async function prepareCheckout(base: string, head: string): Promise<BaseCheckout> {
  if (!existsSync(base)) throw new Error(`no checkout at ${base}`);
  const schemaVersion = await schemaVersionOf(base);
  if (base === head) {
    // This process's own tree: nothing to arrange, and nothing to clean up afterwards.
    return {
      directory: base,
      schemaVersion,
      loader: join(base, 'tools', 'upgrade', 'fixtureMain.ts'),
      checks: join(base, 'tools', 'upgrade', 'checksMain.ts'),
      copiedLoader: false,
      modules: 'already present',
      cleanup: async () => undefined,
    };
  }

  const created: string[] = [];
  let modules: ModulesSource = 'already present';
  const [baseLock, headLock] = await Promise.all([lockfileDigest(base), lockfileDigest(head)]);
  if (existsSync(join(base, 'node_modules'))) {
    const stamped = await readStamp(base);
    if (stamped === null) {
      // Not ours. It can still be trusted, but only on evidence: npm leaves a hidden
      // lockfile beside the tree it installed, and that is what says which
      // `package-lock.json` the tree came from. A checkout somebody prepared with
      // `npm ci` — the ordinary way to point `--tree` at another branch — passes here.
      const own = await hiddenLockfileDisagreement(base);
      if (own !== null) {
        throw new Error(
          `${join(base, 'node_modules')} was not installed from that checkout's package-lock.json (${own}); remove it and let this run install, or run \`npm ci\` there`,
        );
      }
      modules = "reused (that checkout's own npm install, agreeing with its lockfile)";
    } else if (stamped !== baseLock) {
      await rm(join(base, 'node_modules'), { recursive: true, force: true });
      modules = 'rebuilt (the stamp named another lockfile)';
    } else {
      modules = 'reused (stamped with this lockfile)';
    }
  }
  if (!existsSync(join(base, 'node_modules'))) {
    if (baseLock !== null && baseLock === headLock) {
      await buildLinkFarm(base, head);
      if (modules === 'already present') modules = 'linked from HEAD (identical lockfile)';
    } else {
      await install(base);
      if (modules === 'already present') modules = 'npm ci in the base worktree (lockfiles differ)';
    }
    await writeStamp(base, baseLock);
    created.push(join(base, 'node_modules'));
  }

  let loader = join(base, 'tools', 'upgrade', 'fixtureMain.ts');
  let copiedLoader = false;
  if (!existsSync(loader)) {
    if (existsSync(join(base, 'tools', 'upgrade'))) {
      throw new Error(`${base} has a tools/upgrade with no fixtureMain.ts; refusing to write into it`);
    }
    const toolsExisted = existsSync(join(base, 'tools'));
    await mkdir(join(base, 'tools'), { recursive: true });
    await cp(join(head, 'tools', 'upgrade'), join(base, 'tools', 'upgrade'), { recursive: true });
    created.push(toolsExisted ? join(base, 'tools', 'upgrade') : join(base, 'tools'));
    copiedLoader = true;
    loader = join(base, 'tools', 'upgrade', 'fixtureMain.ts');
  }

  return {
    directory: base,
    schemaVersion,
    loader,
    checks: join(base, 'tools', 'upgrade', 'checksMain.ts'),
    copiedLoader,
    modules,
    async cleanup() {
      for (const path of created.reverse()) await rm(path, { recursive: true, force: true });
    },
  };
}
