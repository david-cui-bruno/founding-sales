import { readdirSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every file Node loads without a bundler is plain strip-only TypeScript (lane g86).
 *
 * `npm run package` and `npm run verify:package` run `node --experimental-strip-types`
 * on `scripts/*.ts`, and those import `src/main` and `@fss/contracts` directly. Node's
 * strip-only mode removes type annotations and nothing else: a constructor parameter
 * property, an `enum`, a `namespace` or an `import =` has to be *compiled*, and Node
 * refuses the whole file with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. vitest and esbuild
 * compile all of them, so every other test in this workspace passes over such a file,
 * and the first thing to notice is a step run on a Mac: the class of failure that broke
 * PR 218's host check. `KeychainError` in `src/main/keychain.ts` still carried a
 * `constructor(readonly reason …)` until this lane.
 *
 * So this runs Node's own stripper — `module.stripTypeScriptTypes` in `strip` mode,
 * the transform `--experimental-strip-types` applies — over every file in the four
 * directories the package step can reach. `erasableSyntaxOnly` in the desktop and
 * contracts `tsconfig.json` is the same rule at typecheck time; this is the one that
 * asks Node.
 *
 * The vacuous-pass trap is a walk that finds nothing, or a stripper that accepts
 * anything. The first test requires the walk to have found the files it must, and
 * the second requires the stripper to refuse the exact shape that broke the build.
 */

const DESKTOP = fileURLToPath(new URL('../..', import.meta.url));
const REPOSITORY = join(DESKTOP, '..', '..');

const LOADED_BY_NODE = [
  join(REPOSITORY, 'packages', 'contracts', 'src'),
  join(DESKTOP, 'src', 'main'),
  join(DESKTOP, 'src', 'shared'),
  join(DESKTOP, 'scripts'),
];

function typeScriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...typeScriptFiles(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) found.push(path);
  }
  return found.sort();
}

/** Null when Node strips the file, otherwise Node's reason. */
function refusal(source: string): string | null {
  try {
    stripTypeScriptTypes(source, { mode: 'strip' });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('the files the package step loads under strip-only TypeScript', () => {
  const files = LOADED_BY_NODE.flatMap(typeScriptFiles);
  const named = files.map(file => relative(REPOSITORY, file));

  it('are found where the package step reaches them', () => {
    for (const expected of [
      'packages/contracts/src/index.ts',
      'apps/desktop/src/main/keychain.ts',
      'apps/desktop/src/main/bundleScheme.ts',
      'apps/desktop/src/shared/contract.ts',
      'apps/desktop/scripts/package.ts',
      'apps/desktop/scripts/verifyPackage.ts',
    ]) {
      expect(named).toContain(expected);
    }
    expect(files.length).toBeGreaterThan(40);
  });

  it('are refused by Node when they carry syntax that must be compiled', () => {
    expect(refusal('export class KeychainError extends Error {\n  constructor(readonly reason: string) {\n    super(reason);\n  }\n}\n')).toMatch(
      /parameter property/u,
    );
    expect(refusal('export enum Screen { Today }\n')).not.toBeNull();
    expect(refusal('export const answer: number = 42;\n')).toBeNull();
  });

  it('are every one strip-only TypeScript', () => {
    const refused = files
      .map(file => ({ file: relative(REPOSITORY, file), reason: refusal(readFileSync(file, 'utf8')) }))
      .filter(entry => entry.reason !== null);
    expect(refused).toEqual([]);
  });
});
