import { cp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
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
 * **Third-party modules.** A base checkout created with `git worktree add` has no
 * `node_modules`. Rather than a second `npm ci` — minutes, and a network the upgrade
 * test otherwise never needs — a link farm is built: every entry of HEAD's
 * `node_modules` symlinked, **except** `@fss`, whose five workspace packages are
 * symlinked into the *base* tree. So the child gets HEAD's third-party dependencies
 * and the base's own first-party code, which is exactly the split that matters. A base
 * that already has a real `node_modules` is left alone and used as it is.
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

export interface BaseCheckout {
  readonly directory: string;
  /** `REQUIRED_SCHEMA` as this checkout declares it. */
  readonly schemaVersion: number;
  /** The loader entry point to run, absolute. */
  readonly loader: string;
  /** True when HEAD's `tools/upgrade` was copied in because the base had none. */
  readonly copiedLoader: boolean;
  /** True when a `node_modules` link farm was built for this run. */
  readonly linkedModules: boolean;
  cleanup(): Promise<void>;
}

const REQUIRED_SCHEMA_LINE = /^export const REQUIRED_SCHEMA = (\d+);$/mu;

/** `REQUIRED_SCHEMA` out of a checkout's own copy of the file, never out of memory. */
export async function schemaVersionOf(checkout: string): Promise<number> {
  const path = join(checkout, 'packages', 'domain', 'db', 'schemaRange.ts');
  if (!existsSync(path)) throw new Error(`${checkout} has no packages/domain/db/schemaRange.ts`);
  const match = REQUIRED_SCHEMA_LINE.exec(await readFile(path, 'utf8'));
  if (match?.[1] === undefined) throw new Error(`${path} declares no REQUIRED_SCHEMA`);
  return Number(match[1]);
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

export async function prepareBaseCheckout(base: string, head: string): Promise<BaseCheckout> {
  if (!existsSync(base)) throw new Error(`no base checkout at ${base}`);
  if (base === head) throw new Error('the base checkout and this one are the same directory');
  const schemaVersion = await schemaVersionOf(base);

  const created: string[] = [];
  const linkedModules = !existsSync(join(base, 'node_modules'));
  if (linkedModules) {
    await buildLinkFarm(base, head);
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
    copiedLoader,
    linkedModules,
    async cleanup() {
      for (const path of created.reverse()) await rm(path, { recursive: true, force: true });
    },
  };
}
