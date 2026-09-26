#!/usr/bin/env node
// The changelog, one fragment file per pull request (lane a3, 25 September 2026).
//
//   npm run changelog          writes docs/greenfield/changelog.md from the fragments
//   npm run changelog:check    fails when a fragment is malformed, or when changelog.md
//                              says anything the fragments do not
//   npm run changelog:check -- --strict
//                              also fails when a fragment is not folded in yet
//
// Why fragments: `docs/greenfield/changelog.md` took one line at the top per pull
// request, so every two open pull requests conflicted over it, and every lane re-stacked
// for a one-line merge (nine times on the night of 25 September). A fragment is a file of
// its own, `docs/greenfield/changelog/<yyyy-mm-dd>-pr<n>.md`, or
// `<yyyy-mm-dd>-<branch-slug>.md` while the pull request has no number, holding exactly
// the one line that used to go at the top. Two new files never conflict.
//
// Why the gate does not require the fragment to be folded in: a pull request that also
// rewrote changelog.md would put its line at the top of the same list as every other
// open pull request, and they would conflict exactly as before. So a pull request adds
// its fragment and nothing else, and `npm run changelog` folds merged fragments into
// changelog.md in a pull request of its own. What the check refuses is a changelog.md
// that is not what `npm run changelog` writes for the fragments it lists: a line written
// by hand, a line whose fragment was edited or deleted, the lines out of order, or the
// generated header changed. A fragment not folded in yet is reported, and with --strict
// refused.
//
// The lines written by hand before the fragments are below the "Before 25 Sep 2026"
// heading of changelog.md itself. They are history: the generator keeps them as they
// stand and never reads them as fragments.
//
// The order is newest first: by the date in the file name, then by the rest of the name,
// with pull request numbers compared as numbers, so PR 99 comes before PR 100 on the
// same day in reading order, below it.
//
// Only node's own modules: the nightly runs this without an install.
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHANGELOG_PATH = 'docs/greenfield/changelog.md';
export const FRAGMENT_DIRECTORY = 'docs/greenfield/changelog';
export const BEFORE_HEADING = '## Before 25 Sep 2026';

/** `<yyyy-mm-dd>-pr<n>.md` or `<yyyy-mm-dd>-<branch-slug>.md`. */
const FRAGMENT_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;
/** `- YYYY-MM-DD PR <n> (<lane>): <text>` or `- YYYY-MM-DD branch <branch> (<lane>): <text>`. */
const FRAGMENT_LINE = /^- (\d{4}-\d{2}-\d{2}) (?:PR ([1-9]\d*)|branch ([A-Za-z0-9._/-]+)) \(([^()\s][^()]*)\): \S(?:.*\S)?$/u;

/** The header `npm run changelog` writes above the fragment lines. */
export const HEADER = [
  '# FSS changelog',
  '',
  'This file is generated: `npm run changelog` writes it from the fragment files in [`changelog/`](changelog/), and nothing above "Before 25 Sep 2026" is edited by hand.',
  '',
  'One line per merged change, newest first:',
  '',
  '```',
  '- YYYY-MM-DD PR <n> (<lane>): <what changed for the founder or operator>',
  '```',
  '',
  'Each line is a fragment: one file under `docs/greenfield/changelog/` holding exactly that line, added in the pull request that makes the change. Name it `<yyyy-mm-dd>-pr<n>.md`, or `<yyyy-mm-dd>-<branch-slug>.md` with `branch <branch>` in place of `PR <n>` while the pull request has no number yet; the date in the name is the line\'s date, and the slug is the branch name in lower case with every run of other characters as one `-` (`a3/changelog-fragments` is `a3-changelog-fragments`). A pull request adds its fragment and does not touch this file, so no two pull requests conflict over the changelog; merged fragments are folded in with `npm run changelog`, in a pull request of its own. `npm run changelog:check`, in the greenfield gate and the nightly, fails on a malformed fragment and on anything above "Before 25 Sep 2026" that the fragments do not say, and lists the fragments not folded in yet. Lines of one day sort by file name, pull request numbers as numbers.',
  '',
  'Say what the founder or the operator will notice, not how it was built; the pull request and the code say how. From 25 September 2026 this replaces the numbered release records that `release.md` used to collect, and a decision is a line here too unless it changes an interface or a safety rule (`docs/decisions/README.md`). What is still unverified lives in `release.md` 8.1, not here.',
  '',
  'The lines from 21 to 25 September 2026 were seeded from the release records 8.0 to 8.0av, one line each, dated as the record dates itself. The bracketed number ending each names its record in [`release-records.md`](release-records.md). Changes merged in those days without a record of their own are not listed; `git log --merges` has them.',
].join('\n');

/** A branch name as it appears in a fragment's file name. */
export function branchSlug(branch) {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function isCalendarDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * One fragment, from its file name and its text: `{ fragment }` or `{ problems }`.
 * A fragment is one non-empty line, with or without its final newline, that names the
 * pull request its file name names, or the branch its slug came from, on the same date.
 */
export function parseFragment(name, text) {
  const problems = [];
  const where = `${FRAGMENT_DIRECTORY}/${name}`;
  const named = FRAGMENT_NAME.exec(name);
  if (named === null) {
    return { problems: [`${where}: the name is not <yyyy-mm-dd>-pr<n>.md or <yyyy-mm-dd>-<branch-slug>.md`] };
  }
  const [, nameDate, rest] = named;
  const prName = /^pr(\d+)$/u.exec(rest);
  if (prName !== null && !/^[1-9]\d*$/u.test(prName[1])) problems.push(`${where}: the pull request number has a leading zero`);
  if (!isCalendarDate(nameDate)) problems.push(`${where}: ${nameDate} is not a date`);

  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body.trim() === '') return { problems: [...problems, `${where}: the fragment is empty`] };
  if (/[\r\n]/u.test(body)) return { problems: [...problems, `${where}: the fragment is more than one line`] };
  const line = FRAGMENT_LINE.exec(body);
  if (line === null) {
    return {
      problems: [
        ...problems,
        `${where}: the line is not "- YYYY-MM-DD PR <n> (<lane>): <text>" or "- YYYY-MM-DD branch <branch> (<lane>): <text>"`,
      ],
    };
  }
  const [, lineDate, pr, branch] = line;
  if (lineDate !== nameDate) problems.push(`${where}: the line is dated ${lineDate} and the name ${nameDate}`);
  if (prName !== null) {
    if (pr === undefined) problems.push(`${where}: the name names PR ${prName[1]} and the line names a branch`);
    else if (pr !== prName[1]) problems.push(`${where}: the name names PR ${prName[1]} and the line PR ${pr}`);
  } else if (branch === undefined) {
    problems.push(`${where}: the name is a branch slug and the line names PR ${pr}; name it ${nameDate}-pr${pr}.md`);
  } else if (branchSlug(branch) !== rest) {
    problems.push(`${where}: the line names branch ${branch}, whose slug is ${branchSlug(branch)}, not ${rest}`);
  }
  if (problems.length > 0) return { problems };
  return { fragment: { name, date: nameDate, key: rest, pr: pr === undefined ? null : Number(pr), branch: branch ?? null, line: body } };
}

/** Plain ordering, except that runs of digits compare as numbers. */
function naturalCompare(left, right) {
  const tokens = text => text.match(/\d+|\D+/gu) ?? [];
  const a = tokens(left);
  const b = tokens(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === y) continue;
    if (/^\d/u.test(x) && /^\d/u.test(y)) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference;
    }
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Newest first: by date, then by the rest of the name, both descending. */
export function newestFirst(fragments) {
  return [...fragments].sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? 1 : -1;
    return naturalCompare(right.key, left.key);
  });
}

/** Everything from the "Before 25 Sep 2026" heading to the end, or null when the heading is missing. */
export function beforeSection(changelog) {
  if (changelog.startsWith(`${BEFORE_HEADING}\n`)) return changelog;
  const at = changelog.indexOf(`\n${BEFORE_HEADING}\n`);
  return at < 0 ? null : changelog.slice(at + 1);
}

/** changelog.md as `npm run changelog` writes it. */
export function renderChangelog(fragments, before) {
  const lines = newestFirst(fragments).map(fragment => fragment.line);
  return [HEADER, '', ...lines, ...(lines.length > 0 ? [''] : []), before].join('\n');
}

/** Every fragment in the tree at `root`: `{ fragments, problems }`. */
export function readFragments(root) {
  const directory = join(root, FRAGMENT_DIRECTORY);
  const fragments = [];
  const problems = [];
  let names;
  try {
    names = readdirSync(directory).sort();
  } catch {
    return { fragments, problems: [`${FRAGMENT_DIRECTORY}/ does not exist`] };
  }
  for (const name of names) {
    // .DS_Store and friends: never committed, and not fragments.
    if (name.startsWith('.')) continue;
    if (!statSync(join(directory, name)).isFile()) {
      problems.push(`${FRAGMENT_DIRECTORY}/${name}: not a file`);
      continue;
    }
    const parsed = parseFragment(name, readFileSync(join(directory, name), 'utf8'));
    if (parsed.problems !== undefined) problems.push(...parsed.problems);
    else fragments.push(parsed.fragment);
  }
  const seen = new Map();
  for (const fragment of fragments) {
    const id = fragment.pr === null ? `branch ${fragment.branch}` : `PR ${String(fragment.pr)}`;
    if (seen.has(id)) problems.push(`${FRAGMENT_DIRECTORY}/${fragment.name}: ${id} already has ${seen.get(id)}`);
    else seen.set(id, fragment.name);
  }
  return { fragments, problems };
}

/**
 * Whether `changelog` is what `npm run changelog` writes for the fragments it lists.
 * Returns `{ problems, folded, unfolded }`; with `strict`, a fragment not folded in is a
 * problem too.
 */
export function checkChangelog(changelog, fragments, { strict = false } = {}) {
  const before = beforeSection(changelog);
  if (before === null) return { problems: [`${CHANGELOG_PATH} has no "${BEFORE_HEADING}" heading`], folded: [], unfolded: [] };
  const head = changelog.slice(0, changelog.length - before.length);
  const listed = new Set(head.split('\n'));
  const folded = fragments.filter(fragment => listed.has(fragment.line));
  const unfolded = fragments.filter(fragment => !listed.has(fragment.line));
  const problems = [];
  const lines = new Set(fragments.map(fragment => fragment.line));
  for (const line of head.split('\n')) {
    if (/^- \d{4}-\d{2}-\d{2} /u.test(line) && !lines.has(line)) {
      problems.push(`${CHANGELOG_PATH} has a line no fragment holds (add a fragment instead of editing the file): ${line}`);
    }
  }
  if (problems.length === 0 && renderChangelog(folded, before) !== changelog) {
    problems.push(`${CHANGELOG_PATH} is not what \`npm run changelog\` writes for the ${String(folded.length)} fragment(s) it lists: the header or the order was edited by hand`);
  }
  if (strict) {
    for (const fragment of newestFirst(unfolded)) {
      problems.push(`${FRAGMENT_DIRECTORY}/${fragment.name} is not folded into ${CHANGELOG_PATH}`);
    }
  }
  return { problems, folded, unfolded };
}

function main(args) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const known = new Set(['--check', '--strict']);
  const unknown = args.filter(arg => !known.has(arg));
  if (unknown.length > 0 || (args.includes('--strict') && !args.includes('--check'))) {
    console.error('usage: node scripts/changelog.mjs [--check [--strict]]');
    return 2;
  }
  const { fragments, problems } = readFragments(root);
  const changelogPath = join(root, CHANGELOG_PATH);
  const changelog = readFileSync(changelogPath, 'utf8');

  if (args.includes('--check')) {
    const result = checkChangelog(changelog, fragments, { strict: args.includes('--strict') });
    const all = [...problems, ...result.problems];
    for (const problem of all) console.error(`CHANGELOG ${problem}`);
    if (all.length > 0) {
      console.error(`changelog check failed: ${String(all.length)} problem(s).`);
      return 1;
    }
    const pending = newestFirst(result.unfolded).map(fragment => fragment.name);
    console.log(
      `${CHANGELOG_PATH} matches its fragments: ${String(result.folded.length)} folded in, ${String(pending.length)} not yet` +
        (pending.length > 0 ? ` (\`npm run changelog\` folds them in): ${pending.join(', ')}` : ''),
    );
    return 0;
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`CHANGELOG ${problem}`);
    console.error(`${CHANGELOG_PATH} not written: ${String(problems.length)} problem(s).`);
    return 1;
  }
  const before = beforeSection(changelog);
  if (before === null) {
    console.error(`CHANGELOG ${CHANGELOG_PATH} has no "${BEFORE_HEADING}" heading; the lines below it are kept as they stand.`);
    return 1;
  }
  const next = renderChangelog(fragments, before);
  if (next !== changelog) writeFileSync(changelogPath, next);
  console.log(`${CHANGELOG_PATH} ${next === changelog ? 'was already current' : 'written'}: ${String(fragments.length)} fragment(s).`);
  return 0;
}

// Real paths on both sides: node runs the main module from its real path, and a checkout
// under a symlink (macOS's /var is /private/var) would otherwise never run main.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
