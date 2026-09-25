import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * The release mutation list is one file per area (lane g93, David's decision of
 * 25 September 2026).
 *
 * Until g93 every mutation was one entry of a `const MUTATIONS = [...]` in
 * `scripts/releaseMutationCheck.mjs`, and every lane appended to its end, so every pull
 * request that added a trap conflicted with every other. The entries are now in
 * `scripts/mutations/<area>.mjs`, the area chosen by the file each entry edits
 * (`MUTATION_AREAS` in `scripts/releaseMutationRunner.mjs`), and `loadMutations` reads
 * them in area file name order.
 *
 * ## The vacuous-pass traps, named
 *
 * Four, and each is a way for the check to run fewer mutations than it lists while
 * still printing "N mutation(s) killed, 0 problem(s)".
 *
 * A loader that found no file, or files that exported nothing, would hand the runner an
 * empty list. Closed by requiring a file for every area with at least one entry in it,
 * the counts summing to what was loaded, and by fixtures the loader must refuse: an
 * empty directory and an area file with an empty list.
 *
 * An entry filed under the wrong area still runs, so nothing but the loader notices,
 * and the next lane to look for it looks in the wrong file. A fixture puts a worker
 * entry in `api.mjs` and the loader must refuse it, naming the right file.
 *
 * An entry left in `scripts/releaseMutationCheck.mjs` by a rebase that kept the old
 * list would never run. The check script must hold no entry of its own.
 *
 * And an entry whose text has moved is found here, on the pull request that moved it,
 * rather than by the nightly the next morning: every `find` must appear exactly once in
 * its file, which is step 1 of the check itself.
 *
 * One more, about the `kind` tags lane g86 added (audit T08): an entry marked
 * `kind: 'wiring'` edits the suite's own map, and the runner reports those kills apart.
 * A later commit of the same pull request dropped all eighteen tags while appending
 * entries, and nothing noticed, because an untagged entry is simply `'behaviour'`. The
 * tags are back, every kind must be one the runner knows, and the count of wiring
 * entries has a floor.
 */

interface Mutation {
  name: string;
  file: string;
  find: string;
  replace: string;
  suite: string[];
  because: string;
  kind?: string;
}

interface AreaRule {
  readonly area: string;
  readonly prefixes: readonly string[];
}

interface Runner {
  MUTATION_AREAS: readonly AreaRule[];
  MUTATION_KINDS: readonly string[];
  mutationArea(file: string): string | null;
  mutationKind(mutation: Mutation): string;
  loadMutations(directory: string): Promise<{
    mutations: Mutation[];
    areas: { area: string; file: string; count: number }[];
  }>;
}

// A computed specifier, as in mutationRunner.check.ts: plain ESM with no declarations.
const RUNNER_PATH = repositoryPath('scripts/releaseMutationRunner.mjs');
const runner = (await import(RUNNER_PATH)) as Runner;
const DIRECTORY = repositoryPath('scripts/mutations');
const { mutations, areas } = await runner.loadMutations(DIRECTORY);

describe('the release mutation list, one file per area', () => {
  it('has a file for every area and nothing else in the directory', () => {
    const expected = runner.MUTATION_AREAS.map(rule => `${rule.area}.mjs`).sort();
    expect(expected.length).toBeGreaterThanOrEqual(12);
    expect(readdirSync(DIRECTORY).sort()).toEqual(expected);
    expect(areas.map(area => area.file)).toEqual(expected);
  });

  it('loads every entry of every file, and each file has at least one', () => {
    for (const area of areas) expect(area.count, `${area.file} holds no mutation`).toBeGreaterThan(0);
    expect(areas.reduce((sum, area) => sum + area.count, 0)).toBe(mutations.length);
    // The floor: 243 entries when the list was split, on main at 039c50bd.
    expect(mutations.length).toBeGreaterThanOrEqual(243);
    expect(new Set(mutations.map(mutation => mutation.name)).size).toBe(mutations.length);
  });

  it('files each entry under the area of the file it edits, in area file name order', () => {
    let at = 0;
    for (const area of areas) {
      for (const mutation of mutations.slice(at, at + area.count)) {
        expect(runner.mutationArea(mutation.file), `${area.file}: ${mutation.name}`).toBe(area.area);
      }
      at += area.count;
    }
    // The rule is first match: a release script is not "infra", a domain module with its
    // own area is not "domain-other".
    expect(runner.mutationArea('infra/scripts/release-deploy.sh')).toBe('release-scripts');
    expect(runner.mutationArea('infra/modules/cluster/main.tf')).toBe('infra');
    expect(runner.mutationArea('packages/domain/outbound/gate.ts')).toBe('domain-outbound');
    expect(runner.mutationArea('packages/domain/dial/calls.ts')).toBe('domain-other');
    expect(runner.mutationArea('README.md')).toBeNull();
  });

  it('finds the text of every entry exactly once in the file it edits', () => {
    for (const mutation of mutations) {
      const occurrences = readRepositoryFile(mutation.file).split(mutation.find).length - 1;
      expect(occurrences, `${mutation.name}: its text appears ${String(occurrences)} times in ${mutation.file}`).toBe(1);
      expect(mutation.find).not.toBe(mutation.replace);
      expect(mutation.suite[0], `${mutation.name}: a suite is an npm run`).toBe('run');
      expect(mutation.because.length, `${mutation.name} says nothing about its trap`).toBeGreaterThan(30);
    }
  });

  it('gives every entry a kind the runner knows, and keeps the wiring tags', () => {
    for (const mutation of mutations) {
      expect(runner.MUTATION_KINDS, `${mutation.name}: kind ${String(mutation.kind)}`).toContain(runner.mutationKind(mutation));
    }
    const wiring = mutations.filter(mutation => runner.mutationKind(mutation) === 'wiring');
    // Eighteen when lane g86 tagged them: every workflow entry, and the scenario map's two.
    expect(wiring.length).toBeGreaterThanOrEqual(18);
    for (const mutation of wiring) {
      expect(['workflows', 'release-scripts'], mutation.name).toContain(runner.mutationArea(mutation.file));
    }
  });

  it('leaves no entry in the check script, which loads the area files', () => {
    const check = readRepositoryFile('scripts/releaseMutationCheck.mjs');
    expect(check).not.toMatch(/^const MUTATIONS\b/mu);
    expect(check).not.toMatch(/^ +find:/mu);
    expect(check).toContain('await loadMutations(`${ROOT}scripts/mutations`)');
  });
});

describe('the loader refuses a list that would check less than it says', () => {
  let directory: string | null = null;
  afterEach(() => {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  const entry = (name: string, file: string): Mutation => ({
    name,
    file,
    find: 'a',
    replace: 'b',
    suite: ['run', 'test:release'],
    because: 'a fixture',
  });
  function fixture(files: Record<string, readonly Mutation[] | string>): string {
    directory = mkdtempSync(join(tmpdir(), 'fss-mutation-list-'));
    for (const [file, contents] of Object.entries(files)) {
      const text = typeof contents === 'string' ? contents : `export const MUTATIONS = ${JSON.stringify(contents)};\n`;
      writeFileSync(join(directory, file), text);
    }
    return directory;
  }

  it('loads a well-formed fixture, the positive control', async () => {
    const loaded = await runner.loadMutations(
      fixture({ 'worker.mjs': [entry('two', 'apps/worker/src/b.ts')], 'api.mjs': [entry('one', 'apps/api/src/a.ts')] }),
    );
    expect(loaded.mutations.map(mutation => mutation.name)).toEqual(['one', 'two']);
    expect(loaded.areas).toEqual([
      { area: 'api', file: 'api.mjs', count: 1 },
      { area: 'worker', file: 'worker.mjs', count: 1 },
    ]);
  });

  it('refuses an empty directory and an empty list', async () => {
    await expect(runner.loadMutations(fixture({}))).rejects.toThrow('no mutation area file');
    await expect(runner.loadMutations(fixture({ 'api.mjs': [] }))).rejects.toThrow('hold no entry');
  });

  it('refuses an entry in the wrong area, naming the right one', async () => {
    await expect(runner.loadMutations(fixture({ 'api.mjs': [entry('misfiled', 'apps/worker/src/b.ts')] }))).rejects.toThrow(
      'api.mjs: "misfiled" edits apps/worker/src/b.ts, which belongs in worker.mjs',
    );
    await expect(runner.loadMutations(fixture({ 'api.mjs': [entry('nowhere', 'README.md')] }))).rejects.toThrow(
      'belongs in no area',
    );
  });

  it('refuses a file that is not an area, a file without the array, and a name used twice', async () => {
    await expect(runner.loadMutations(fixture({ 'misc.mjs': [entry('one', 'apps/api/src/a.ts')] }))).rejects.toThrow(
      'misc.mjs is not a mutation area',
    );
    await expect(runner.loadMutations(fixture({ 'api.mjs': 'export default [];\n' }))).rejects.toThrow(
      'api.mjs does not export a MUTATIONS array',
    );
    await expect(
      runner.loadMutations(
        fixture({ 'api.mjs': [entry('same', 'apps/api/src/a.ts')], 'worker.mjs': [entry('same', 'apps/worker/src/b.ts')] }),
      ),
    ).rejects.toThrow('worker.mjs: "same" is already the name of an entry in api.mjs');
  });
});
