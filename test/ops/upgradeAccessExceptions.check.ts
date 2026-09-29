import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  baselineAndMigrationBothChanged,
  loadAccessExceptions,
  runtimeAccessNoneTables,
} from '../../tools/upgrade/grants.ts';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';

/**
 * Who is allowed to say that a privilege change was reviewed.
 *
 * Not the migration. A migration used to carry its own `-- runtime-access: none`
 * comment, which the tool accepted as review, and a `REVOKE` inside a migration silently
 * became the new expectation — so a feature quietly losing access passed (GPT-6 review
 * of PR 314, P0-3). Both are the same shape: the thing under review writing its own
 * review. Exceptions and declared deltas now live in `tools/upgrade/access-exceptions.json`,
 * a file a reviewer has to open separately, and every entry carries a `why` somebody
 * wrote.
 *
 * The behaviour against a real database is exercised by the upgrade test itself. What
 * these cases pin is the file's contract and the two rules that live outside it: that
 * the header form is gone, and that the baseline cannot move in the same pull request
 * as a migration.
 */

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function exceptionsFile(document: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'fss-access-exceptions-'));
  temporary.push(directory);
  const path = join(directory, 'access-exceptions.json');
  writeFileSync(path, JSON.stringify(document), 'utf8');
  return path;
}

describe('access-exceptions.json is the only place an access change can be excused', () => {
  it('the committed file loads, and declares nothing at the schema this branch ships', () => {
    const exceptions = loadAccessExceptions();
    expect(runtimeAccessNoneTables(exceptions, 0, 22)).toEqual([]);
  });

  it('refuses an entry nobody wrote a reason for', () => {
    for (const document of [
      { migrations: { '0023': { runtimeAccessNone: [{ table: 'x' }] } } },
      { migrations: { '0023': { runtimeAccessNone: [{ table: 'x', why: '   ' }] } } },
      {
        migrations: {
          '0023': { existingTableDeltas: [{ table: 'firms', role: 'app_runtime', revoke: ['DELETE'], why: '' }] },
        },
      },
    ]) {
      expect(() => loadAccessExceptions(exceptionsFile(document))).toThrow(/why/u);
    }
  });

  it('excuses a table only within the range of the migration it is declared under', () => {
    const path = exceptionsFile({
      migrations: { '0022': { runtimeAccessNone: [{ table: 'funnel_facts', why: 'written by the worker only' }] } },
    });
    const exceptions = loadAccessExceptions(path);
    expect(runtimeAccessNoneTables(exceptions, 21, 22)).toEqual(['funnel_facts']);
    expect(runtimeAccessNoneTables(exceptions, 22, 23)).toEqual([]);
  });
});

describe('the `-- runtime-access:` header form is gone', () => {
  it('no migration carries one, and nothing reads one', () => {
    // A migration that can exempt itself is not reviewed. If this ever fails because
    // somebody reintroduced the header, the fix is a row in access-exceptions.json.
    for (const file of readdirSync(repositoryPath('packages/domain/db/migrations'))) {
      if (!file.endsWith('.sql')) continue;
      expect(readRepositoryFile(`packages/domain/db/migrations/${file}`), file).not.toContain('runtime-access:');
    }
    // `grants.ts` may still *say* the words — the comment recording why the form was
    // removed is worth keeping — but only in a comment, never in code that reads one.
    for (const line of readRepositoryFile('tools/upgrade/grants.ts').split('\n')) {
      if (!line.includes('runtime-access')) continue;
      expect(line.trimStart(), line).toMatch(/^(\*|\/\/|\/\*)/u);
    }
  });
});

describe('the grants baseline may not move in the same pull request as a migration', () => {
  it('sees both halves, and neither alone', () => {
    expect(
      baselineAndMigrationBothChanged([
        'tools/upgrade/grants-baseline.json',
        'packages/domain/db/migrations/0023_x.sql',
      ]),
    ).toBe(true);
    expect(baselineAndMigrationBothChanged(['tools/upgrade/grants-baseline.json'])).toBe(false);
    expect(baselineAndMigrationBothChanged(['packages/domain/db/migrations/0023_x.sql'])).toBe(false);
    expect(baselineAndMigrationBothChanged(['tools/upgrade/main.ts'])).toBe(false);
  });

  it('the upgrade workflow enforces the same rule over the whole branch, not per commit', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield.yml');
    expect(workflow).toContain('The grants baseline may not move in the same pull request as a migration');
    expect(workflow).toContain('tools/upgrade/grants-baseline.json');
  });
});
