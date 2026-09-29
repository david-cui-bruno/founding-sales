import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * `infra/scripts/classify-migration.sh` — one word per migration, and the statements
 * that decided it (lane RS, 29 September 2026).
 *
 * The release procedure rehearses `touches-existing`, `privilege` and `destructive`
 * and does not rehearse `additive`, so a classifier that answered "additive" for a
 * `DROP COLUMN` would remove the rehearsal from exactly the release that needs it.
 * Each class therefore has a fixture migration of its own, written into a temporary
 * directory so the cases say what they mean rather than depending on which real
 * migration happens to be the last one of its kind.
 *
 * "Existing" is the trap worth naming. It is not a guess from the name: it is the set
 * of tables the earlier files in the *same directory* create and do not drop, which is
 * why `existing_table` below has to be created by a fixture migration before the case
 * that alters it — and why a `CREATE INDEX` on a table this file itself creates is
 * additive while the same statement on an older one is not.
 */

const SCRIPT = repositoryPath('infra/scripts/classify-migration.sh');

/** Migrations 1 and 2 of every fixture directory: the world that already exists. */
const FOUNDATION: readonly (readonly [string, string])[] = [
  [
    '0001_foundation.sql',
    [
      '-- changes: none',
      'CREATE TABLE existing_table (id integer PRIMARY KEY, note text);',
      'CREATE TABLE append_only (id integer PRIMARY KEY);',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;',
      '',
    ].join('\n'),
  ],
];

function classify(files: readonly (readonly [string, string])[], subject: string): { status: number; stdout: string } {
  const directory = mkdtempSync(join(tmpdir(), 'fss-classify-'));
  for (const [name, sql] of [...FOUNDATION, ...files]) writeFileSync(join(directory, name), sql, 'utf8');
  const result = spawnSync(SCRIPT, [join(directory, subject)], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}

describe('classify-migration.sh', () => {
  it('calls a file that only creates new objects additive', () => {
    const { status, stdout } = classify(
      [
        [
          '0002_additive.sql',
          [
            '-- changes: none',
            'CREATE TABLE brand_new (id integer PRIMARY KEY, body text);',
            'CREATE INDEX brand_new_by_body ON brand_new (body);',
            'CREATE OR REPLACE FUNCTION answer() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;',
            'GRANT SELECT, INSERT ON brand_new TO app_runtime, migration;',
            '',
          ].join('\n'),
        ],
      ],
      '0002_additive.sql',
    );
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('additive');
    expect(stdout).toContain('every object this file names is new');
  });

  it('calls an ALTER of a table that already exists touches-existing, and names the statement', () => {
    const { status, stdout } = classify(
      [
        [
          '0002_touches.sql',
          [
            '-- changes: existing_table',
            'ALTER TABLE existing_table ADD COLUMN added_at timestamptz;',
            '',
          ].join('\n'),
        ],
      ],
      '0002_touches.sql',
    );
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('touches-existing');
    expect(stdout).toContain('ALTER TABLE: existing_table');
    expect(stdout).toContain('ADD COLUMN added_at');
  });

  it('calls a GRANT on a table that already exists privilege', () => {
    const { status, stdout } = classify(
      [
        [
          '0002_privilege.sql',
          ['-- changes: none', 'REVOKE UPDATE, DELETE, TRUNCATE ON append_only FROM app_runtime, migration;', ''].join('\n'),
        ],
      ],
      '0002_privilege.sql',
    );
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('privilege');
    expect(stdout).toContain('REVOKE on the existing append_only');
  });

  it('calls a DROP COLUMN destructive even when the rest of the file is additive', () => {
    const { status, stdout } = classify(
      [
        [
          '0002_destructive.sql',
          [
            '-- changes: existing_table',
            'CREATE TABLE replacement (id integer PRIMARY KEY);',
            'ALTER TABLE existing_table DROP COLUMN note;',
            '',
          ].join('\n'),
        ],
      ],
      '0002_destructive.sql',
    );
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('destructive');
    expect(stdout).toContain('DROP COLUMN on existing_table');
  });

  it('does not read a statement inside a function body as a statement of the migration', () => {
    // Migration 0023 carries `INSERT INTO today_snapshots` inside a CREATE OR REPLACE
    // FUNCTION. A line-oriented classifier calls that file touches-existing; it is not.
    const { status, stdout } = classify(
      [
        [
          '0002_function_body.sql',
          [
            '-- changes: none',
            'CREATE OR REPLACE FUNCTION refresh() RETURNS void LANGUAGE plpgsql AS $body$',
            'BEGIN',
            "  INSERT INTO existing_table (id, note) VALUES (1, 'x');",
            '  DELETE FROM existing_table;',
            'END;',
            '$body$;',
            '',
          ].join('\n'),
        ],
      ],
      '0002_function_body.sql',
    );
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('additive');
  });

  it('calls a DELETE with no WHERE destructive and a DELETE with one touches-existing', () => {
    const withWhere = classify(
      [['0002_delete.sql', ['-- changes: existing_table', 'DELETE FROM existing_table WHERE id = 1;', ''].join('\n')]],
      '0002_delete.sql',
    );
    expect(withWhere.stdout.split('\n')[0]).toBe('touches-existing');
    const without = classify(
      [['0002_delete.sql', ['-- changes: existing_table', 'DELETE FROM existing_table;', ''].join('\n')]],
      '0002_delete.sql',
    );
    expect(without.stdout.split('\n')[0]).toBe('destructive');
    expect(without.stdout).toContain('DELETE without a WHERE');
  });

  it('refuses a file whose name is not a migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-classify-'));
    writeFileSync(join(directory, 'notes.sql'), 'SELECT 1;', 'utf8');
    const result = spawnSync(SCRIPT, [join(directory, 'notes.sql')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a migration file name');
  });

  it('agrees with the real migrations this repository already has', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['0017_release_records.sql', 'additive'],
      ['0020_postal_address.sql', 'touches-existing'],
      ['0021_compat_cleanup.sql', 'destructive'],
      ['0022_funnel_facts.sql', 'additive'],
    ];
    for (const [file, expected] of cases) {
      const result = spawnSync(SCRIPT, [repositoryPath(`packages/domain/db/migrations/${file}`)], { encoding: 'utf8' });
      expect(result.status, `${file}: ${result.stderr}`).toBe(0);
      expect(result.stdout.split('\n')[0], file).toBe(expected);
    }
  });
});
