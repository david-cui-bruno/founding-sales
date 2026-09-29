import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Relative, and deliberately nothing else. This module is run as a script by the
// `upgrade` job's guard *before* `npm ci`, so it may not import anything that is not
// either Node's own or a dependency-free file in this repository. `migrationRunner.ts`
// qualifies: it imports `node:crypto`, `node:fs`, `node:path`, `node:url` and a
// sibling of pure types. Keep it that way — an import of `pg` here would mean the
// guard could not run until the install had, and the install is minutes the skip path
// should not pay.
import { loadMigrations } from '../../packages/domain/db/migrationRunner.ts';

/**
 * Is a branch about to change a migration production has already applied?
 *
 * This is the one implementation of that question. The tool asks it at step 0, before
 * it creates anything; the `upgrade` job's guard asks it through
 * `deployedMigrationsMain.ts` before it decides there is nothing to test. Two
 * implementations would be two answers, and the cheaper one was a git-level comparison
 * of blob ids — which is not what the runner checks. The runner hashes the bytes it
 * reads off disk, so a `.gitattributes` change that makes HEAD check the same blob out
 * with CRLF line endings leaves the blob ids identical and the checksums different
 * (GPT-6, third review of PR 314, P0-1). These are the checked-out bytes.
 *
 * `loadMigrations` is the runner's own loader, so the filename rule is the runner's
 * too: a `.sql` file that is not `NNNN_snake_case.sql` throws
 * `MIGRATION_FILE_NAME_INVALID` here exactly as it would in production, rather than
 * being silently skipped or truncated at a space by a shell parser.
 */
export interface DeployedMigrationDifference {
  readonly fileName: string;
  readonly reason: 'content_differs' | 'missing_in_head' | 'missing_in_base';
  readonly baseChecksum: string | null;
  readonly headChecksum: string | null;
}

/**
 * Every migration up to `through` must be byte-identical in the two checkouts.
 *
 * The runner records a sha256 of each file's bytes and refuses to continue when a
 * recorded file has changed (`MIGRATION_CHECKSUM_MISMATCH`), because migrations are
 * forward-only and there is nothing to fall back to. A branch that edits an already
 * deployed file and adds a new one would therefore be *refused by production* — and
 * would have passed this test, which applied HEAD's copy of the old file and recorded
 * HEAD's checksum for it.
 *
 * So the deployed range is compared before anything is applied, and the answer is the
 * same one production would give. The runner is still the backstop: 1..N are applied
 * from the base checkout and N+1..M from HEAD, so a difference this function somehow
 * missed fails again, with the runner's own error, at the second apply.
 */
export function compareDeployedMigrations(
  baseDirectory: string,
  headDirectory: string,
  through: number,
): readonly DeployedMigrationDifference[] {
  const checksum = (sql: string): string => createHash('sha256').update(sql, 'utf8').digest('hex');
  const upTo = (directory: string): Map<string, string> =>
    new Map(
      loadMigrations(directory)
        .filter(migration => migration.version <= through)
        .map(migration => [migration.fileName, checksum(readFileSync(join(directory, migration.fileName), 'utf8'))]),
    );
  // Which directory failed matters: `loadMigrations` is the runner's own loader, so a
  // name it refuses or a gap in the sequence is production's answer too — but its
  // message names neither the checkout nor the branch it came from.
  const load = (directory: string, whose: string): Map<string, string> => {
    try {
      return upTo(directory);
    } catch (error) {
      throw new Error(`${whose} (${directory}): ${error instanceof Error ? error.message : 'could not be read'}`);
    }
  };
  const base = load(baseDirectory, 'the deployed checkout');
  const head = load(headDirectory, 'this branch');
  const differences: DeployedMigrationDifference[] = [];
  for (const [fileName, baseChecksum] of base) {
    const headChecksum = head.get(fileName);
    if (headChecksum === undefined) {
      differences.push({ fileName, reason: 'missing_in_head', baseChecksum, headChecksum: null });
      continue;
    }
    if (headChecksum !== baseChecksum) {
      differences.push({ fileName, reason: 'content_differs', baseChecksum, headChecksum });
    }
  }
  for (const [fileName, headChecksum] of head) {
    if (!base.has(fileName)) {
      differences.push({ fileName, reason: 'missing_in_base', baseChecksum: null, headChecksum });
    }
  }
  return differences.sort((left, right) => left.fileName.localeCompare(right.fileName));
}
