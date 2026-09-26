import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * The repository root is the greenfield workspace root and nothing else (lanes g89, g95).
 *
 * Lane g89 made the root defaults greenfield and moved the previous-generation Electron
 * app's scripts under a `legacy:` prefix. Lane g95 deleted that app (`src/`, `client/`,
 * `cloud/`, `native/`, `tests/`, its scripts, configs and dependencies; the last tree
 * is the `legacy-final` tag). This file holds the result: the bare defaults are
 * greenfield, every root script is one this file names, no `legacy:` script or old-app
 * dependency comes back, the install builds nothing, and every `npm run` target exists.
 *
 * ## The vacuous-pass traps, named
 *
 * Three.
 *
 * "No script is legacy" is true of a reader that found no scripts. Closed by comparing
 * the script names with an exact list, which an empty object fails, and by pinning the
 * three defaults to their exact commands.
 *
 * "Every `npm run` target exists" is true of a parser that found no `npm run` in any
 * script. Closed by requiring it to find the targets of `gate:greenfield` before
 * judging the rest.
 *
 * "No old-app dependency" is true of a reader that found no dependencies. Closed by
 * requiring the root devDependencies to be exactly the lint and test tooling the root
 * scripts run.
 */

interface Manifest {
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly main?: string;
  readonly workspaces?: readonly string[];
}

const manifest = JSON.parse(readRepositoryFile('package.json')) as Manifest;
const scripts = manifest.scripts;

/** Every root script. */
const SCRIPTS = [
  'gate:greenfield',
  'lint',
  'lint:greenfield',
  'lint:root-scripts',
  'package:desktop',
  'postinstall',
  'test',
  'test:desktop:e2e',
  'test:desktop:host',
  'test:greenfield',
  'test:release',
  'test:release:mutation',
  'typecheck',
  'typecheck:greenfield',
  // The Gitleaks scan of the history and the tree. `.github/workflows/ci.yml` and
  // `greenfield-infra.yml` run it by this name.
  'verify:secrets',
  'verify:desktop:package',
] as const;

/** The root's own devDependencies: what `lint:root-scripts`, `lint:greenfield`, `typecheck:greenfield` and `test:release` run. */
const DEV_DEPENDENCIES = [
  '@eslint/js',
  '@typescript-eslint/eslint-plugin',
  '@typescript-eslint/parser',
  'eslint',
  'eslint-plugin-import',
  'globals',
  'typescript',
  'vitest',
] as const;

/** The root scripts each `npm run <name>` in `command` names; a `--workspace` run names a package's script. */
function rootTargets(command: string): string[] {
  return command
    .split('&&')
    .map(part => part.trim())
    .flatMap(part => {
      const match = /^npm run (\S+)(.*)$/u.exec(part);
      if (match === null || match[1] === undefined) return [];
      return /(?:^|\s)(?:--workspace|-w)(?:\s|=)/u.test(match[2] ?? '') ? [] : [match[1]];
    });
}

describe('the repository root is the greenfield workspace root', () => {
  it('runs the greenfield typecheck, lint and tests for the bare names', () => {
    expect(scripts['typecheck']).toBe('npm run typecheck:greenfield');
    expect(scripts['lint']).toBe('npm run lint:greenfield && npm run lint:root-scripts');
    expect(scripts['test']).toBe('npm run test:greenfield && npm run test:release');
    // What `.github/workflows/greenfield.yml` runs.
    expect(scripts['gate:greenfield']).toBe(
      'npm run typecheck:greenfield && npm run lint:greenfield && npm run test:greenfield && npm run test:release',
    );
  });

  it('has exactly the named scripts: no start, no legacy: script', () => {
    expect(scripts['start']).toBeUndefined();
    expect(Object.keys(scripts).filter(name => name.startsWith('legacy:'))).toEqual([]);
    expect(Object.keys(scripts).sort()).toEqual([...SCRIPTS].sort());
  });

  it('builds nothing on install', () => {
    // The Electron binary, which the desktop host tests need (docs/greenfield/install.md).
    expect(scripts['postinstall']).toBe('install-electron --no');
    for (const hook of ['preinstall', 'install', 'preprepare', 'prepare', 'postprepare']) {
      expect(scripts[hook], hook).toBeUndefined();
    }
  });

  it('every npm run target exists', () => {
    // The floor: the parser finds the targets it must find.
    expect(rootTargets(scripts['gate:greenfield'] ?? '')).toEqual([
      'typecheck:greenfield',
      'lint:greenfield',
      'test:greenfield',
      'test:release',
    ]);
    expect(rootTargets(scripts['test:greenfield'] ?? '')).toEqual([]);

    for (const [name, command] of Object.entries(scripts)) {
      for (const target of rootTargets(command)) {
        expect(scripts[target], `${name} runs npm run ${target}, which does not exist`).toBeDefined();
      }
    }
  });

  it('depends on nothing of the old app: no runtime dependencies, only the lint and test tooling', () => {
    expect(manifest.workspaces).toEqual(['apps/*', 'packages/*']);
    expect(manifest.main).toBeUndefined();
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toEqual([...DEV_DEPENDENCIES].sort());
  });
});
