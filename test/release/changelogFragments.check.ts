import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * The changelog is one fragment file per pull request (lane a3, 25 September 2026).
 *
 * `docs/greenfield/changelog.md` took one line at the top per pull request, so every two
 * open pull requests conflicted over it. Now a pull request adds
 * `docs/greenfield/changelog/<yyyy-mm-dd>-pr<n>.md` (or `<yyyy-mm-dd>-<branch-slug>.md`
 * while it has no number) holding exactly that one line, and `npm run changelog`
 * (`scripts/changelog.mjs`) folds merged fragments into changelog.md, newest first, above
 * the hand-written lines kept under "Before 25 Sep 2026". A pull request does not rewrite
 * changelog.md itself, because two that did would conflict exactly as before; so
 * `npm run changelog:check`, in the gate and the nightly, fails on a malformed fragment
 * and on anything in changelog.md the fragments do not say, and only lists a fragment not
 * folded in yet (`--strict` refuses that too).
 *
 * ## The vacuous-pass traps, named
 *
 * Three.
 *
 * "Every fragment is one line naming a PR or a branch" is true of a reader that found no
 * fragments. Closed by requiring the 33 lines of 25 September that became fragments, by
 * name, and by reading each file raw here rather than only through the script's parser.
 *
 * "changelog.md is current" is true of a check that compares the file with itself, or
 * that accepts anything. Closed by requiring the file to be exactly the script's own
 * rendering of the fragments it lists, and by running the check on files broken each way
 * it must refuse — a line written by hand, a fragment edited or deleted after it was
 * folded in, the lines reordered, the header edited — and requiring each to fail.
 *
 * And a check that is right in this file but not wired is decoration. Closed by running
 * the script as the gate runs it, `npm run changelog:check`, from a copy of the tree with
 * each break, and by reading the nightly's job and the gate script.
 */

interface Fragment {
  readonly name: string;
  readonly date: string;
  readonly key: string;
  readonly pr: number | null;
  readonly branch: string | null;
  readonly line: string;
}

interface Check {
  readonly problems: string[];
  readonly folded: Fragment[];
  readonly unfolded: Fragment[];
}

interface ChangelogScript {
  readonly CHANGELOG_PATH: string;
  readonly FRAGMENT_DIRECTORY: string;
  readonly BEFORE_HEADING: string;
  readonly HEADER: string;
  branchSlug(branch: string): string;
  parseFragment(name: string, text: string): { fragment?: Fragment; problems?: string[] };
  newestFirst(fragments: readonly Fragment[]): Fragment[];
  beforeSection(changelog: string): string | null;
  renderChangelog(fragments: readonly Fragment[], before: string): string;
  readFragments(root: string): { fragments: Fragment[]; problems: string[] };
  checkChangelog(changelog: string, fragments: readonly Fragment[], options?: { strict?: boolean }): Check;
}

// A computed specifier, as in mutationSchedule.check.ts: plain ESM with no declarations.
const SCRIPT_PATH = repositoryPath('scripts/changelog.mjs');
const script = (await import(SCRIPT_PATH)) as ChangelogScript;

const CHANGELOG = 'docs/greenfield/changelog.md';
const DIRECTORY = 'docs/greenfield/changelog';
/** The pull requests of 25 September 2026 whose lines were at the top of changelog.md. */
const SEEDED = [
  201, 205, 206, 209, 210, 211, 213, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 233, 234,
  235, 236, 237, 239, 240, 241, 242, 243,
];
/** Independent of the script: one line, dated, naming a pull request or a branch, and a lane. */
const LINE = /^- (\d{4}-\d{2}-\d{2}) (PR [1-9]\d*|branch \S+) \([^()]+\): \S/u;

function fragment(name: string, line: string): Fragment {
  const parsed = script.parseFragment(name, `${line}\n`);
  if (parsed.fragment === undefined) throw new Error(`fixture ${name}: ${(parsed.problems ?? []).join('; ')}`);
  return parsed.fragment;
}

describe('every fragment is one non-empty line that names a pull request or a branch', () => {
  const names = readdirSync(repositoryPath(DIRECTORY)).filter(name => !name.startsWith('.'));

  it('has the 33 lines of 25 September among them, each under its pull request', () => {
    // The floor: a directory the reader found empty would pass everything below.
    for (const pr of SEEDED) expect(names, `PR ${String(pr)}`).toContain(`2026-09-25-pr${String(pr)}.md`);
  });

  it('reads each file raw: one line, with no blank or second line, naming what its file name names', () => {
    for (const name of names) {
      const text = readRepositoryFile(`${DIRECTORY}/${name}`);
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      expect(lines, name).toHaveLength(1);
      const line = lines[0] ?? '';
      expect(line.trim(), name).not.toBe('');
      const match = LINE.exec(line);
      expect(match, `${name}: ${line}`).not.toBeNull();
      const [, date, named] = match ?? [];
      expect(name.startsWith(`${date ?? ''}-`), `${name} is not named for ${date ?? ''}`).toBe(true);
      const rest = name.slice(11, -3);
      if (/^pr\d+$/u.test(rest)) expect(named, name).toBe(`PR ${rest.slice(2)}`);
      else expect(script.branchSlug((named ?? '').replace(/^branch /u, '')), name).toBe(rest);
    }
  });

  it('is accepted by the script, with no two fragments naming the same pull request', () => {
    const { fragments, problems } = script.readFragments(repositoryPath(''));
    expect(problems).toEqual([]);
    expect(fragments).toHaveLength(names.length);
  });
});

describe('changelog.md is what `npm run changelog` writes for its fragments', () => {
  const changelog = readRepositoryFile(CHANGELOG);
  const { fragments } = script.readFragments(repositoryPath(''));
  const result = script.checkChangelog(changelog, fragments);
  const before = script.beforeSection(changelog) ?? '';

  it('passes the check, with the 33 lines of 25 September folded in', () => {
    expect(result.problems).toEqual([]);
    const folded = result.folded.map(entry => entry.name);
    for (const pr of SEEDED) expect(folded).toContain(`2026-09-25-pr${String(pr)}.md`);
  });

  it('is exactly the rendering of the fragments it lists, above the lines kept from before', () => {
    expect(changelog).toBe(script.renderChangelog(result.folded, before));
    expect(changelog.startsWith(`${script.HEADER}\n`)).toBe(true);
    expect(changelog.split('\n')[2]).toMatch(/^This file is generated: `npm run changelog` writes it/u);
  });

  it('keeps the hand-written lines of 21 to 24 September below the heading, as they stood', () => {
    expect(before.startsWith(`${script.BEFORE_HEADING}\n`)).toBe(true);
    const kept = before.split('\n').filter(line => line.startsWith('- '));
    expect(kept).toHaveLength(28);
    expect(kept[0]).toMatch(/^- 2026-09-24 PR 199 \(g56\): /u);
    expect(kept.at(-1)).toMatch(/^- 2026-09-21 PR 153 \(g12f\): /u);
    // No line is in both halves.
    for (const entry of fragments) expect(before).not.toContain(entry.line);
  });
});

describe('the check refuses every way changelog.md can stop matching its fragments', () => {
  const before = `${script.BEFORE_HEADING}\n\n- 2026-09-24 PR 1 (g1): an old line\n`;
  const older = fragment('2026-09-25-pr99.md', '- 2026-09-25 PR 99 (g9): the older change');
  const newer = fragment('2026-09-25-pr100.md', '- 2026-09-25 PR 100 (g10): the newer change');
  const branch = fragment('2026-09-26-a3-changelog-fragments.md', '- 2026-09-26 branch a3/changelog-fragments (a3): the newest');
  const all = [older, newer, branch];
  const current = script.renderChangelog(all, before);

  it('orders newest first, by date and then by name with numbers as numbers', () => {
    expect(script.newestFirst([older, branch, newer]).map(entry => entry.name)).toEqual([
      '2026-09-26-a3-changelog-fragments.md',
      '2026-09-25-pr100.md',
      '2026-09-25-pr99.md',
    ]);
    expect(current).toBe(`${script.HEADER}\n\n${branch.line}\n${newer.line}\n${older.line}\n\n${before}`);
  });

  it('accepts the current file, strictly too', () => {
    expect(script.checkChangelog(current, all).problems).toEqual([]);
    expect(script.checkChangelog(current, all, { strict: true }).problems).toEqual([]);
  });

  it('lists a fragment not folded in yet, and refuses it only with --strict', () => {
    const stale = script.renderChangelog([older, newer], before);
    const lenient = script.checkChangelog(stale, all);
    expect(lenient.problems).toEqual([]);
    expect(lenient.unfolded.map(entry => entry.name)).toEqual([branch.name]);
    expect(script.checkChangelog(stale, all, { strict: true }).problems).toEqual([
      `${DIRECTORY}/${branch.name} is not folded into ${CHANGELOG}`,
    ]);
  });

  it('refuses a line written by hand, and a folded fragment edited or deleted', () => {
    const handWritten = current.replace(`${branch.line}\n`, `${branch.line}\n- 2026-09-26 PR 7 (g7): written by hand\n`);
    expect(script.checkChangelog(handWritten, all).problems.join('\n')).toContain('a line no fragment holds');
    const edited = fragment('2026-09-25-pr100.md', '- 2026-09-25 PR 100 (g10): the newer change, reworded');
    expect(script.checkChangelog(current, [older, edited, branch]).problems.join('\n')).toContain('PR 100 (g10): the newer change');
    expect(script.checkChangelog(current, [older, branch]).problems).toHaveLength(1);
  });

  it('refuses the lines reordered, the header edited, and a missing heading', () => {
    const reordered = current.replace(`${newer.line}\n${older.line}\n`, `${older.line}\n${newer.line}\n`);
    expect(reordered).not.toBe(current);
    expect(script.checkChangelog(reordered, all).problems.join('\n')).toContain('not what `npm run changelog` writes');
    const header = current.replace('This file is generated', 'This file is written');
    expect(script.checkChangelog(header, all).problems.join('\n')).toContain('not what `npm run changelog` writes');
    const headless = current.replace(`${script.BEFORE_HEADING}\n`, '## Older\n');
    expect(script.checkChangelog(headless, all).problems.join('\n')).toContain('no "## Before 25 Sep 2026" heading');
  });

  it('refuses a malformed fragment: two lines, empty, misnamed, or naming something else', () => {
    const problems = (name: string, text: string) => (script.parseFragment(name, text).problems ?? []).join('\n');
    const good = '- 2026-09-26 PR 250 (g1): a change\n';
    expect(problems('2026-09-26-pr250.md', good)).toBe('');
    expect(problems('2026-09-26-pr250.md', good.trimEnd())).toBe('');
    expect(problems('2026-09-26-pr250.md', `${good}${good}`)).toContain('more than one line');
    expect(problems('2026-09-26-pr250.md', '\n')).toContain('empty');
    expect(problems('2026-09-26-pr250.md', '- 2026-09-26 (g1): a change\n')).toContain('the line is not');
    expect(problems('pr250.md', good)).toContain('the name is not');
    expect(problems('2026-09-26-PR250.md', good)).toContain('the name is not');
    expect(problems('2026-09-26-pr251.md', good)).toContain('names PR 251 and the line PR 250');
    expect(problems('2026-09-27-pr250.md', good)).toContain('dated 2026-09-26 and the name 2026-09-27');
    expect(problems('2026-02-30-pr250.md', good.replace('2026-09-26', '2026-02-30'))).toContain('is not a date');
    expect(problems('2026-09-26-a3-slug.md', good)).toContain('name it 2026-09-26-pr250.md');
    expect(problems('2026-09-26-a3-other.md', '- 2026-09-26 branch a3/slug (a3): a change\n')).toContain('whose slug is a3-slug');
    expect(problems('2026-09-26-pr250.md', '- 2026-09-26 branch a3/slug (a3): a change\n')).toContain('the line names a branch');
  });
});

describe('`npm run changelog` and `npm run changelog:check` do what the gate relies on', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fss-changelog-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** A tree with the script and the given fragments; changelog.md as given, or as the script writes it. */
  function tree(name: string, fragments: Record<string, string>): string {
    const root = join(scratch, name);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, DIRECTORY), { recursive: true });
    copyFileSync(SCRIPT_PATH, join(root, 'scripts/changelog.mjs'));
    for (const [file, line] of Object.entries(fragments)) writeFileSync(join(root, DIRECTORY, file), `${line}\n`);
    writeFileSync(join(root, CHANGELOG), `# old\n\n${script.BEFORE_HEADING}\n\n- 2026-09-24 PR 1 (g1): an old line\n`);
    return root;
  }
  const run = (root: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(root, 'scripts/changelog.mjs'), ...args], { encoding: 'utf8' });
  const LINES = {
    '2026-09-25-pr99.md': '- 2026-09-25 PR 99 (g9): the older change',
    '2026-09-25-pr100.md': '- 2026-09-25 PR 100 (g10): the newer change',
  };

  it('writes changelog.md from the fragments, keeping the lines below the heading, and then passes the check', () => {
    const root = tree('write', LINES);
    expect(run(root, '--check').status).toBe(1);
    const written = run(root);
    expect(written.status, written.stderr).toBe(0);
    const text = readFileSync(join(root, CHANGELOG), 'utf8');
    expect(text).toContain(`${LINES['2026-09-25-pr100.md']}\n${LINES['2026-09-25-pr99.md']}\n\n${script.BEFORE_HEADING}\n`);
    expect(text.endsWith('- 2026-09-24 PR 1 (g1): an old line\n')).toBe(true);
    expect(run(root, '--check', '--strict').status).toBe(0);
  });

  it('passes a new fragment not folded in, fails it with --strict, and fails a hand edit', () => {
    const root = tree('pending', LINES);
    expect(run(root).status).toBe(0);
    writeFileSync(join(root, DIRECTORY, '2026-09-26-pr101.md'), '- 2026-09-26 PR 101 (g11): a new change\n');
    const lenient = run(root, '--check');
    expect(lenient.status, lenient.stderr).toBe(0);
    expect(lenient.stdout).toContain('1 not yet');
    expect(run(root, '--check', '--strict').status).toBe(1);

    unlinkSync(join(root, DIRECTORY, '2026-09-26-pr101.md'));
    const path = join(root, CHANGELOG);
    writeFileSync(path, readFileSync(path, 'utf8').replace('\n\n- 2026-09-25 PR 100', '\n\n- 2026-09-26 PR 101 (g11): by hand\n- 2026-09-25 PR 100'));
    const handEdit = run(root, '--check');
    expect(handEdit.status).toBe(1);
    expect(handEdit.stderr).toContain('a line no fragment holds');
  });

  it('refuses to write, and fails the check, on a malformed fragment', () => {
    const root = tree('malformed', { ...LINES, '2026-09-26-pr101.md': '- 2026-09-26 PR 102 (g11): the wrong number' });
    expect(run(root).status).toBe(1);
    expect(readFileSync(join(root, CHANGELOG), 'utf8').startsWith('# old\n')).toBe(true);
    expect(run(root, '--check').stderr).toContain('names PR 101 and the line PR 102');
  });

  it('is in the gate, is linted, and runs without an install', () => {
    const scripts = (JSON.parse(readRepositoryFile('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['changelog']).toBe('node scripts/changelog.mjs');
    expect(scripts['changelog:check']).toBe('node scripts/changelog.mjs --check');
    expect(scripts['gate:greenfield']?.split(' && ')).toContain('npm run changelog:check');
    expect(scripts['lint:root-scripts']).toContain(' scripts/changelog.mjs ');
    const imports = readRepositoryFile('scripts/changelog.mjs').match(/^import .+ from '([^']+)';$/gmu) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/from 'node:[a-z]+'/u);
  });

  it('runs in the nightly, in a job of its own that nothing can make quiet', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-nightly.yml');
    const at = workflow.indexOf('\n  changelog:\n');
    expect(at).toBeGreaterThan(0);
    const job = workflow.slice(at + 1);
    // The last job: nothing after it at the jobs' indentation.
    expect(job.slice(1).match(/^ {2}\S/mu)).toBeNull();
    expect(job).toContain('\n      - name: Changelog check\n        run: npm run changelog:check\n');
    expect(job).toContain("node-version: '24.20.0'");
    expect(job).not.toMatch(/continue-on-error|\n {8}if: /u);
  });
});
