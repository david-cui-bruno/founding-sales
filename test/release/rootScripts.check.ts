import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * The repository root's defaults are the greenfield product (lane g89, audit item G10).
 *
 * Until lane g89 the root `package.json` belonged to the previous-generation Electron
 * app: `npm start` was Electron Forge, `npm test`, `npm run typecheck` and `npm run lint`
 * ran the old trees' gate, and `postinstall` built two native modules for it. The old
 * app is unused, and its code stays until David decides its deletion, so its scripts
 * stay too, all under a `legacy:` prefix (`docs/greenfield/legacy.md`).
 *
 * This file holds that shape: the bare defaults are greenfield, every unprefixed script
 * is one this file names, the install builds nothing of the old app, and no greenfield
 * script reaches a `legacy:` one.
 *
 * ## The vacuous-pass traps, named
 *
 * Two.
 *
 * "No unprefixed script is legacy" is true of a reader that found no scripts. Closed by
 * comparing the unprefixed names with an exact list, which an empty object fails, and by
 * pinning the three defaults to their exact commands.
 *
 * "Every `npm run` target exists" is true of a parser that found no `npm run` in any
 * script. Closed by requiring it to find the targets of `gate:greenfield` and of
 * `legacy:setup` before judging the rest.
 */

interface Manifest {
  readonly scripts: Readonly<Record<string, string>>;
}

const scripts = (JSON.parse(readRepositoryFile('package.json')) as Manifest).scripts;

/** Every root script without the `legacy:` prefix: the greenfield ones and the one shared check. */
const UNPREFIXED = [
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
  // The Gitleaks scan of the history and the tree. It guards the whole repository,
  // and `.github/workflows/ci.yml` and `greenfield-infra.yml` run it by this name.
  'verify:secrets',
  'verify:desktop:package',
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

describe('the repository root defaults to the greenfield product', () => {
  it('runs the greenfield typecheck, lint and tests for the bare names', () => {
    expect(scripts['typecheck']).toBe('npm run typecheck:greenfield');
    expect(scripts['lint']).toBe('npm run lint:greenfield && npm run lint:root-scripts');
    expect(scripts['test']).toBe('npm run test:greenfield && npm run test:release');
    // Unchanged by lane g89, and what `.github/workflows/greenfield.yml` runs.
    expect(scripts['gate:greenfield']).toBe(
      'npm run typecheck:greenfield && npm run lint:greenfield && npm run test:greenfield && npm run test:release',
    );
  });

  it('has no bare start: nothing greenfield is a development runner, and the old one is legacy:start', () => {
    expect(scripts['start']).toBeUndefined();
    expect(scripts['legacy:start']).toBe('electron-forge start');
  });

  it('prefixes every other script legacy:', () => {
    const unprefixed = Object.keys(scripts)
      .filter(name => !name.startsWith('legacy:'))
      .sort();
    expect(unprefixed).toEqual([...UNPREFIXED].sort());
  });

  it('builds nothing of the old app on install', () => {
    // The Electron binary, which the desktop host tests need (docs/greenfield/install.md).
    // The old app's safe-log-fs and SQLite rebuilds are `npm run legacy:setup`.
    expect(scripts['postinstall']).toBe('install-electron --no');
    for (const hook of ['preinstall', 'install', 'preprepare', 'prepare', 'postprepare']) {
      expect(scripts[hook], hook).toBeUndefined();
    }
    expect(scripts['legacy:setup']).toBe('npm run legacy:build:safe-log-fs && npm run legacy:rebuild');
  });

  it('never reaches a legacy script from a greenfield one, and every npm run target exists', () => {
    // The floor: the parser finds the targets it must find.
    expect(rootTargets(scripts['gate:greenfield'] ?? '')).toEqual([
      'typecheck:greenfield',
      'lint:greenfield',
      'test:greenfield',
      'test:release',
    ]);
    expect(rootTargets(scripts['legacy:setup'] ?? '')).toEqual(['legacy:build:safe-log-fs', 'legacy:rebuild']);
    expect(rootTargets(scripts['test:greenfield'] ?? '')).toEqual([]);

    for (const [name, command] of Object.entries(scripts)) {
      for (const target of rootTargets(command)) {
        expect(scripts[target], `${name} runs npm run ${target}, which does not exist`).toBeDefined();
        if (!name.startsWith('legacy:')) {
          expect(target.startsWith('legacy:'), `${name} reaches ${target}`).toBe(false);
        }
      }
    }
  });
});
