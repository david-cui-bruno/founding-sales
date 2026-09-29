import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareDeployedMigrations } from '../../tools/upgrade/migrate.ts';
import { repositoryPath } from './support/repository.ts';

/**
 * A branch may not change a migration that has already been applied (lane RS, after the
 * GPT-6 review of PR 314, P0-1).
 *
 * The upgrade test used to apply 1..N from HEAD's directory, so a branch that edited
 * deployed migration 0022 and added 0023 recorded *HEAD's* 0022 checksum and passed —
 * while production's runner, which recorded the old one, would refuse the release with
 * `MIGRATION_CHECKSUM_MISMATCH`. The deployed range is now applied from the deployed
 * checkout's own files and compared byte for byte before anything is created.
 *
 * The comparison is what these cases are about. That the tool then *fails* on a
 * non-empty answer is `main.ts`'s first act, before the cluster is started.
 */

const REAL_MIGRATIONS = repositoryPath('packages/domain/db/migrations');

function checkoutOf(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fss-deployed-'));
  cpSync(REAL_MIGRATIONS, directory, { recursive: true });
  return directory;
}

describe('the deployed migrations are immutable', () => {
  it('finds nothing when the two checkouts hold the same bytes', () => {
    expect(compareDeployedMigrations(checkoutOf(), checkoutOf(), 22)).toEqual([]);
  });

  it('finds a deployed file head edited, and says which', () => {
    const base = checkoutOf();
    const head = checkoutOf();
    const edited = join(head, '0022_funnel_facts.sql');
    // A comment is enough: the runner hashes the file's bytes, not its statements, so
    // "it only changed a comment" is not a defence production would accept either.
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n-- a comment added after this file was applied\n`, 'utf8');

    const differences = compareDeployedMigrations(base, head, 22);
    expect(differences).toHaveLength(1);
    expect(differences[0]?.fileName).toBe('0022_funnel_facts.sql');
    expect(differences[0]?.reason).toBe('content_differs');
    expect(differences[0]?.baseChecksum).not.toBe(differences[0]?.headChecksum);
  });

  it('ignores a file above the deployed schema, which is the one being added', () => {
    const base = checkoutOf();
    const head = checkoutOf();
    const edited = join(head, '0022_funnel_facts.sql');
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n-- changed\n`, 'utf8');
    // At schema 21 the edited file is the migration this release is adding, and
    // changing it is what writing a migration is.
    expect(compareDeployedMigrations(base, head, 21)).toEqual([]);
    // At 22 it is deployed, and the same edit is refused.
    expect(compareDeployedMigrations(base, head, 22)).toHaveLength(1);
  });

  it('ignores a file that is not a migration', () => {
    const base = checkoutOf();
    const head = checkoutOf();
    writeFileSync(join(base, 'notes.txt'), 'not a migration', 'utf8');
    writeFileSync(join(head, 'README.md'), 'not a migration either', 'utf8');
    // `loadMigrations` refuses a gap in the numbering, so a *deleted* migration cannot
    // reach this comparison at all: the directory stops loading first, which is the
    // stronger refusal and the one production makes.
    expect(compareDeployedMigrations(base, head, 22)).toEqual([]);
  });

  it('is the same sha256 the migration runner records', () => {
    const base = checkoutOf();
    const head = checkoutOf();
    const edited = join(head, '0021_compat_cleanup.sql');
    writeFileSync(edited, `${readFileSync(edited, 'utf8')} `, 'utf8');
    const differences = compareDeployedMigrations(base, head, 22);
    expect(differences.map(difference => difference.fileName)).toEqual(['0021_compat_cleanup.sql']);
    expect(differences[0]?.baseChecksum).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the upgrade test refuses before it creates anything', () => {
  it('exits non-zero naming step 0 when a deployed migration was edited', () => {
    const head = checkoutOf();
    const edited = join(head, '0022_funnel_facts.sql');
    writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n-- edited after it was applied\n`, 'utf8');

    // A whole checkout is not needed: the tool reads `schemaRange.ts` and the migrations
    // directory out of the paths it is given, and refuses on the comparison before it
    // reaches a cluster. The base is this repository (schema 22) and `--migrations`
    // points at the edited copy.
    const result = spawnSync(
      'node',
      [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        repositoryPath('tools/upgrade/main.ts'),
        '--from', '22',
        '--to', '23',
        '--base', repositoryPath(''),
        '--migrations', head,
      ],
      { encoding: 'utf8', env: { ...process.env, FSS_TEST_POSTGRES_URL: '' } },
    );
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('MIGRATION_CHECKSUM_MISMATCH');
    expect(`${result.stdout}${result.stderr}`).toContain('0022_funnel_facts.sql');
  });
});
