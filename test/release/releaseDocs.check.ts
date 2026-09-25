import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * The runbook is a runbook, and a change is one line (lane g93, David's decision of
 * 25 September 2026).
 *
 * `docs/greenfield/release.md` had collected a numbered record per lane, 8.0 to 8.0au,
 * interleaved with the instructions, until the records were two thirds of the file. They
 * moved verbatim to `docs/greenfield/release-records.md`, which nothing adds to, and a
 * change is now one line of `docs/greenfield/changelog.md`:
 * `- YYYY-MM-DD PR <n> (<lane>): <what changed>`, newest first.
 *
 * ## The vacuous-pass traps, named
 *
 * "No line breaks the format" is true of a changelog the reader found no lines in, so
 * the lines are counted first: at least the 48 seeded from the records. "Every record the
 * runbook cites is in the archive" is true of a runbook the pattern found no citation
 * in, so the citations are counted too. And "the runbook holds no record" is checked
 * against a runbook that still has its sections, the first and the last.
 */

const RUNBOOK = readRepositoryFile('docs/greenfield/release.md');
const RECORDS = readRepositoryFile('docs/greenfield/release-records.md');
const CHANGELOG = readRepositoryFile('docs/greenfield/changelog.md');

const LINE = /^- (\d{4}-\d{2}-\d{2}) PR (\d+) \(([a-z0-9]+)\): (.+)$/u;

describe('the release runbook holds no release record', () => {
  it('still has its sections, from who does what to what is still unverified', () => {
    expect(RUNBOOK).toContain('\n## 0. Who does what\n');
    expect(RUNBOOK).toContain('\n## 8. What this document could not verify\n');
    expect(RUNBOOK).toContain('\n### 8.1 Still unverified\n');
  });

  it('has no 8.0-numbered record, and points at the archive and the changelog instead', () => {
    expect(RUNBOOK).not.toMatch(/^#{2,4} 8\.0[a-z]* /mu);
    expect(RUNBOOK).toContain('(release-records.md)');
    expect(RUNBOOK).toContain('(changelog.md)');
  });

  it('cites only records the archive holds', () => {
    const cited = new Set(RUNBOOK.match(/\b8\.0[a-z]{0,2}\b/gu) ?? []);
    // The floor: the runbook cites the records by number throughout.
    expect(cited.size).toBeGreaterThanOrEqual(20);
    for (const record of cited) {
      expect(RECORDS, `release.md cites ${record}, which release-records.md does not hold`).toContain(`\n### ${record} `);
    }
  });
});

describe('the changelog is one line per change, newest first', () => {
  // Every list line outside the fenced example of the format.
  const lines = CHANGELOG.replace(/^```[^\n]*\n[\s\S]*?^```$/gmu, '')
    .split('\n')
    .filter(line => line.startsWith('- '));

  it('has every seeded line and every line after it in the format', () => {
    expect(lines.length).toBeGreaterThanOrEqual(48);
    for (const line of lines) expect(line, 'a changelog line is "- YYYY-MM-DD PR <n> (<lane>): <what changed>"').toMatch(LINE);
  });

  it('is newest first, and names each pull request once', () => {
    const parsed = lines.map(line => LINE.exec(line)).filter(match => match !== null);
    expect(parsed).toHaveLength(lines.length);
    const dates = parsed.map(match => match[1] ?? '');
    expect(dates).toEqual([...dates].sort().reverse());
    const numbers = parsed.map(match => match[2] ?? '');
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
