import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyMigration } from '../../tools/upgrade/classify.ts';
import { repositoryPath } from './support/repository.ts';

/**
 * `infra/scripts/classify-migration.sh` — one word per migration, and the statements
 * that decided it (lane RS, 29 September 2026).
 *
 * The release procedure rehearses everything except `additive`, so a classifier that
 * answered "additive" for a `DROP COLUMN` would remove the rehearsal from exactly the
 * release that needs it. Each class therefore has a fixture migration of its own,
 * written into a temporary directory so the cases say what they mean rather than
 * depending on which real migration happens to be the last one of its kind.
 *
 * The cases that matter most are the ones that made the classifier fail OPEN: a
 * `DO $$ … $$` block, and any top-level form it does not know. Both used to fall
 * through to `additive`, so `DO $$ BEGIN DELETE FROM sessions; END $$;` was reported
 * as needing no rehearsal — and a table with no fixture rows moves no content hash
 * either, so nothing downstream would have caught it.
 *
 * "Existing" is the trap worth naming. It is not a guess from the name: it is the set
 * of objects the earlier files in the *same directory* create and do not drop, which
 * is why `existing_table` below has to be created by a fixture migration before the
 * case that alters it — and why a `CREATE INDEX` on a table this file itself creates
 * is additive while the same statement on an older one is not. The same now holds for
 * routines: replacing `existing_routine` is `replaces-routine`, and the identical
 * statement for a name nobody has created is `additive`.
 */

const SCRIPT = repositoryPath('infra/scripts/classify-migration.sh');

/**
 * Migration 1 of every fixture directory: the world that already exists.
 *
 * It carries a routine, a trigger and a view as well as the two tables, because "does
 * this routine already exist?" — and, since the second review of PR 314, "does this
 * *view* already exist?" — is a question the classifier answers from the directory.
 */
const FOUNDATION: readonly (readonly [string, string])[] = [
  [
    '0001_foundation.sql',
    [
      '-- changes: none',
      'CREATE TABLE existing_table (id integer PRIMARY KEY, note text);',
      'CREATE TABLE append_only (id integer PRIMARY KEY);',
      'CREATE FUNCTION existing_routine() RETURNS trigger LANGUAGE plpgsql AS $guard$ BEGIN RETURN NEW; END; $guard$;',
      'CREATE TRIGGER existing_trigger BEFORE INSERT ON existing_table FOR EACH ROW EXECUTE FUNCTION existing_routine();',
      'CREATE VIEW existing_view AS SELECT id, note FROM existing_table;',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;',
      '',
    ].join('\n'),
  ],
];

/** A temporary migrations directory holding the foundation plus `files`. */
function fixtureDirectory(files: readonly (readonly [string, string])[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'fss-classify-'));
  for (const [name, sql] of [...FOUNDATION, ...files]) writeFileSync(join(directory, name), sql, 'utf8');
  return directory;
}

function classify(files: readonly (readonly [string, string])[], subject: string): { status: number; stdout: string } {
  const result = spawnSync(SCRIPT, [join(fixtureDirectory(files), subject)], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}

/** One fixture migration, classified, for the cases that only need the first line. */
function classifyOne(name: string, body: readonly string[]): { status: number; stdout: string } {
  return classify([[name, [...body, ''].join('\n')]], name);
}

describe('classify-migration.sh', () => {
  it('calls a file that only creates new objects additive', () => {
    const { status, stdout } = classifyOne('0002_additive.sql', [
      '-- changes: none',
      'CREATE TABLE brand_new (id integer PRIMARY KEY, body text);',
      'CREATE INDEX brand_new_by_body ON brand_new (body);',
      'CREATE OR REPLACE FUNCTION answer() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;',
      'GRANT SELECT, INSERT ON brand_new TO app_runtime, migration;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('additive');
    expect(stdout).toContain('every object this file names is new');
  });

  it('calls an ALTER of a table that already exists touches-existing, and names the statement', () => {
    const { status, stdout } = classifyOne('0002_touches.sql', [
      '-- changes: existing_table',
      'ALTER TABLE existing_table ADD COLUMN added_at timestamptz;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('touches-existing');
    expect(stdout).toContain('ALTER TABLE: existing_table');
    expect(stdout).toContain('ADD COLUMN added_at');
  });

  it('calls a GRANT on a table that already exists privilege', () => {
    const { status, stdout } = classifyOne('0002_privilege.sql', [
      '-- changes: none',
      'REVOKE UPDATE, DELETE, TRUNCATE ON append_only FROM app_runtime, migration;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('privilege');
    expect(stdout).toContain('REVOKE on the existing append_only');
  });

  it('calls a DROP COLUMN destructive even when the rest of the file is additive', () => {
    const { status, stdout } = classifyOne('0002_destructive.sql', [
      '-- changes: existing_table',
      'CREATE TABLE replacement (id integer PRIMARY KEY);',
      'ALTER TABLE existing_table DROP COLUMN note;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('destructive');
    expect(stdout).toContain('DROP COLUMN on existing_table');
  });

  it('does not read a statement inside a function body as a statement of the migration', () => {
    // Migration 0023 carries `INSERT INTO today_snapshots` inside a CREATE OR REPLACE
    // FUNCTION. A line-oriented classifier calls that file touches-existing; it is not.
    const { status, stdout } = classifyOne('0002_function_body.sql', [
      '-- changes: none',
      'CREATE OR REPLACE FUNCTION refresh() RETURNS void LANGUAGE plpgsql AS $body$',
      'BEGIN',
      "  INSERT INTO existing_table (id, note) VALUES (1, 'x');",
      '  DELETE FROM existing_table;',
      'END;',
      '$body$;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('additive');
  });

  it('replaces-routine when that same function body belongs to a routine that already exists', () => {
    // The body is still not read. What changed is the header: `existing_routine` is
    // created by 0001, so everything that calls it behaves differently afterwards.
    const { status, stdout } = classifyOne('0002_function_body.sql', [
      '-- changes: none',
      'CREATE OR REPLACE FUNCTION existing_routine() RETURNS trigger LANGUAGE plpgsql AS $body$',
      'BEGIN',
      '  DELETE FROM existing_table;',
      '  RETURN NEW;',
      'END;',
      '$body$;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('replaces-routine');
    expect(stdout).toContain('which already exists');
    expect(stdout).toContain('routines replaced: existing_routine');
  });

  it('calls a DELETE with no WHERE destructive and a DELETE with one touches-existing', () => {
    const withWhere = classifyOne('0002_delete.sql', ['-- changes: existing_table', 'DELETE FROM existing_table WHERE id = 1;']);
    expect(withWhere.stdout.split('\n')[0]).toBe('touches-existing');
    const without = classifyOne('0002_delete.sql', ['-- changes: existing_table', 'DELETE FROM existing_table;']);
    expect(without.stdout.split('\n')[0]).toBe('destructive');
    expect(without.stdout).toContain('DELETE without a WHERE');
  });

  it('reads the statements of a DO block rather than calling the block additive', () => {
    // The P0 the review found: a DO block is not an ALTER, an UPDATE or a DELETE at
    // the top level, so the old classifier matched nothing and answered additive. With
    // `sessions` empty of fixture rows the content hash does not move either, so the
    // release procedure would have said no rehearsal was needed for a statement that
    // deletes every session in production.
    const { status, stdout } = classifyOne('0002_do_delete.sql', [
      '-- changes: existing_table',
      'DO $$ BEGIN DELETE FROM existing_table; END $$;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('destructive');
    expect(stdout).toContain('DELETE without a WHERE on existing_table');
    expect(stdout).toContain('DO $$');
  });

  it('calls a DO block whose body it cannot read unclassified', () => {
    const { status, stdout } = classifyOne('0002_do_opaque.sql', [
      '-- changes: none',
      'DO $$ BEGIN PERFORM some_opaque_thing(); END $$;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('unclassified');
    expect(stdout).toContain('does not recognise');
    expect(stdout).toContain('some_opaque_thing');
  });

  it('calls a top-level form it does not know unclassified rather than additive', () => {
    const { status, stdout } = classifyOne('0002_cluster.sql', [
      '-- changes: existing_table',
      'CLUSTER existing_table USING existing_table_pkey;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('unclassified');
    expect(stdout).toContain('CLUSTER existing_table');
  });

  it('separates replacing a routine that exists from creating one that does not', () => {
    const replaced = classifyOne('0002_routine.sql', [
      '-- changes: none',
      'CREATE OR REPLACE FUNCTION existing_routine() RETURNS trigger LANGUAGE plpgsql AS $r$ BEGIN RETURN NEW; END; $r$;',
    ]);
    expect(replaced.status).toBe(0);
    expect(replaced.stdout.split('\n')[0]).toBe('replaces-routine');
    expect(replaced.stdout).toContain('CREATE OR REPLACE FUNCTION existing_routine, which already exists');

    const fresh = classifyOne('0002_routine.sql', [
      '-- changes: none',
      'CREATE OR REPLACE FUNCTION brand_new_routine() RETURNS trigger LANGUAGE plpgsql AS $r$ BEGIN RETURN NEW; END; $r$;',
    ]);
    expect(fresh.stdout.split('\n')[0]).toBe('additive');
  });

  it('separates a new trigger on an existing table from a replacement of one that exists', () => {
    const added = classifyOne('0002_trigger.sql', [
      '-- changes: existing_table',
      'CREATE TRIGGER another_trigger AFTER UPDATE ON existing_table FOR EACH ROW EXECUTE FUNCTION existing_routine();',
    ]);
    expect(added.stdout.split('\n')[0]).toBe('touches-existing');
    expect(added.stdout).toContain('CREATE TRIGGER another_trigger on existing_table');

    const replaced = classifyOne('0002_trigger.sql', [
      '-- changes: none',
      'CREATE OR REPLACE TRIGGER existing_trigger BEFORE INSERT ON existing_table FOR EACH ROW EXECUTE FUNCTION existing_routine();',
    ]);
    expect(replaced.stdout.split('\n')[0]).toBe('replaces-routine');
    expect(replaced.stdout).toContain('routines replaced: existing_trigger');
  });

  it('calls a changed column default touches-existing', () => {
    const { status, stdout } = classifyOne('0002_default.sql', [
      '-- changes: existing_table',
      "ALTER TABLE existing_table ALTER COLUMN note SET DEFAULT 'x';",
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('touches-existing');
    expect(stdout).toContain('SET DEFAULT on existing_table');
  });

  it('calls dropping a routine that exists destructive and dropping one that does not additive', () => {
    const dropped = classifyOne('0002_drop_routine.sql', ['-- changes: none', 'DROP FUNCTION existing_routine();']);
    expect(dropped.stdout.split('\n')[0]).toBe('destructive');
    expect(dropped.stdout).toContain('DROP FUNCTION existing_routine');

    const absent = classifyOne('0002_drop_routine.sql', ['-- changes: none', 'DROP FUNCTION IF EXISTS never_existed();']);
    expect(absent.stdout.split('\n')[0]).toBe('additive');
  });

  it('calls dropping a constraint from an existing table destructive', () => {
    const { stdout } = classifyOne('0002_drop_constraint.sql', [
      '-- changes: existing_table',
      'ALTER TABLE existing_table DROP CONSTRAINT existing_table_note_known;',
    ]);
    expect(stdout.split('\n')[0]).toBe('destructive');
    expect(stdout).toContain('DROP CONSTRAINT on existing_table');
  });

  it('refuses a file whose name is not a migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-classify-'));
    writeFileSync(join(directory, 'notes.sql'), 'SELECT 1;', 'utf8');
    const result = spawnSync(SCRIPT, [join(directory, 'notes.sql')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a migration file name');
  });

  it('populates routinesReplaced and hasUnclassified on the classification itself', () => {
    const directory = fixtureDirectory([
      [
        '0002_both.sql',
        [
          '-- changes: none',
          'CREATE OR REPLACE FUNCTION existing_routine() RETURNS trigger LANGUAGE plpgsql AS $r$ BEGIN RETURN NEW; END; $r$;',
          'CLUSTER existing_table USING existing_table_pkey;',
          '',
        ].join('\n'),
      ],
    ]);
    const result = classifyMigration(join(directory, '0002_both.sql'));
    expect(result.kind).toBe('unclassified');
    expect(result.hasUnclassified).toBe(true);
    expect(result.routinesReplaced).toStrictEqual(['existing_routine']);

    const quiet = classifyMigration(join(fixtureDirectory([['0002_quiet.sql', 'CREATE TABLE nothing_yet (id integer PRIMARY KEY);\n']]), '0002_quiet.sql'));
    expect(quiet.kind).toBe('additive');
    expect(quiet.hasUnclassified).toBe(false);
    expect(quiet.routinesReplaced).toStrictEqual([]);
  });

  it('agrees with the real migrations this repository already has', () => {
    // Re-derived by running the script on the files. 0004, 0007 and 0014 end in a bare
    // `SELECT seed_…(…)`, a call whose effect the classifier cannot see, so they fail
    // closed to `unclassified`. 0020 swaps a CHECK constraint under the same name, which
    // the swap carve-out reads as `touches-existing` rather than as the DROP it contains.
    //
    // These are applied history: the class of a migration production already ran is
    // informational, and a conservative answer on an old file costs nothing.
    const cases: readonly (readonly [string, string])[] = [
      ['0004_crm.sql', 'unclassified'],
      // 0006 is the only file in the tree that creates a view. It is listed to hold the
      // view tracking to its promise from the other side: creating `effective_suppressions`
      // is additive *for this file*, so adding views to the classifier moved nothing here.
      // The file as a whole is touches-existing for reasons that have nothing to do with
      // the view — it alters tables 0001 through 0005 created.
      ['0006_policy.sql', 'touches-existing'],
      ['0007_research.sql', 'unclassified'],
      ['0014_retention.sql', 'unclassified'],
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

  it('calls a migration that hands two existing routines new bodies replaces-routine', () => {
    // This is migration 0023's shape, which is why the class exists. 0023 adds no
    // column and drops nothing; what it does is hand `today_algorithm_version()` and
    // `today_refresh_card(…)` new bodies, both of which exist at 22. Under the old
    // four-class list that was `additive`, so the release that changed how every Today
    // card is built would have skipped its rehearsal.
    //
    // It is reproduced here rather than read out of the branch that carries 0023: a
    // check that points at another checkout passes on one machine and fails on every
    // other. The real file is classified by `npm run upgrade:test` itself, which reads
    // the tree it is given.
    const { status, stdout } = classify(
      [
        [
          '0002_routines.sql',
          [
            '-- changes: none',
            'CREATE OR REPLACE FUNCTION today_algorithm_version() RETURNS text',
            "  LANGUAGE sql IMMUTABLE AS $$ SELECT 'today.1' $$;",
            'CREATE TABLE research_settings (workspace_id uuid PRIMARY KEY);',
            'GRANT SELECT, INSERT ON research_settings TO app_runtime, migration;',
            '',
          ].join('\n'),
        ],
        [
          '0003_research.sql',
          [
            '-- changes: none',
            'CREATE TABLE firm_facts (id uuid PRIMARY KEY);',
            'CREATE OR REPLACE FUNCTION today_algorithm_version() RETURNS text',
            "  LANGUAGE sql IMMUTABLE AS $$ SELECT 'today.2' $$;",
            'CREATE OR REPLACE FUNCTION today_refresh_card(p_workspace_id uuid) RETURNS void',
            '  LANGUAGE plpgsql AS $body$',
            '  BEGIN',
            "    INSERT INTO today_snapshots (workspace_id) VALUES (p_workspace_id);",
            '  END;',
            '  $body$;',
            'GRANT SELECT ON firm_facts TO app_runtime, migration;',
            '',
          ].join('\n'),
        ],
      ],
      '0003_research.sql',
    );
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('replaces-routine');
    expect(stdout).toContain('today_algorithm_version');
  });

  it('carries a `CREATE OR REPLACE FUNCTION` of a brand-new routine as additive', () => {
    const { stdout } = classify(
      [
        [
          '0002_new_routine.sql',
          [
            '-- changes: none',
            'CREATE OR REPLACE FUNCTION never_seen_before() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;',
            '',
          ].join('\n'),
        ],
      ],
      '0002_new_routine.sql',
    );
    expect(stdout.split('\n')[0]).toBe('additive');
  });

  it('reads a constraint swap as touches-existing, in one statement and in two', () => {
    // The only narrowing in a classifier that is otherwise fail-closed. A CHECK widened
    // under its own name loses no data, and keeping the name is deliberate: migration
    // 0014 says so out loud — "The constraint keeps its name, so its failing-insert case
    // in `test/db/constraints.test.ts` keeps covering it." Both real forms appear in the
    // tree: 0020 swaps inside one ALTER, 0014 across two.
    const inOne = classify(
      [
        [
          '0002_swap_one.sql',
          [
            '-- changes: existing_table',
            'ALTER TABLE existing_table',
            '  DROP CONSTRAINT existing_table_note_known,',
            "  ADD CONSTRAINT existing_table_note_known CHECK (note IN ('a', 'b', 'c'));",
            '',
          ].join('\n'),
        ],
      ],
      '0002_swap_one.sql',
    );
    expect(inOne.stdout.split('\n')[0]).toBe('touches-existing');
    expect(inOne.stdout).toContain('constraint swap on existing_table');

    const inTwo = classify(
      [
        [
          '0002_swap_two.sql',
          [
            '-- changes: existing_table',
            'ALTER TABLE existing_table DROP CONSTRAINT existing_table_note_known;',
            "ALTER TABLE existing_table ADD CONSTRAINT existing_table_note_known CHECK (note <> '');",
            '',
          ].join('\n'),
        ],
      ],
      '0002_swap_two.sql',
    );
    expect(inTwo.stdout.split('\n')[0]).toBe('touches-existing');
  });

  it('keeps a DROP CONSTRAINT that is not put back destructive', () => {
    const bare = classify(
      [
        [
          '0002_drop_only.sql',
          ['-- changes: existing_table', 'ALTER TABLE existing_table DROP CONSTRAINT existing_table_note_known;', ''].join('\n'),
        ],
      ],
      '0002_drop_only.sql',
    );
    expect(bare.stdout.split('\n')[0]).toBe('destructive');
    expect(bare.stdout).toContain('DROP CONSTRAINT on existing_table');

    // Two dropped, one put back: still a loss, so still destructive.
    const half = classify(
      [
        [
          '0002_half.sql',
          [
            '-- changes: existing_table',
            'ALTER TABLE existing_table',
            '  DROP CONSTRAINT existing_table_note_known,',
            '  DROP CONSTRAINT existing_table_other,',
            "  ADD CONSTRAINT existing_table_note_known CHECK (note <> '');",
            '',
          ].join('\n'),
        ],
      ],
      '0002_half.sql',
    );
    expect(half.stdout.split('\n')[0]).toBe('destructive');
  });

  it('does not read an ADD CONSTRAINT on another table as putting this one back', () => {
    const other = classify(
      [
        [
          '0002_other_table.sql',
          [
            '-- changes: existing_table',
            'ALTER TABLE existing_table DROP CONSTRAINT existing_table_note_known;',
            "ALTER TABLE append_only ADD CONSTRAINT existing_table_note_known CHECK (id > 0);",
            '',
          ].join('\n'),
        ],
      ],
      '0002_other_table.sql',
    );
    expect(other.stdout.split('\n')[0]).toBe('destructive');
  });

  // ------------------------------------------------------------------------- views
  // The second review of PR 314, P0-4. `CREATE OR REPLACE VIEW` used to reach the
  // additive fall-through, so replacing `effective_suppressions` — the view the
  // suppression system answers "is this handle suppressed?" from — with one that
  // returns nothing would have released without a rehearsal, and the upgrade test
  // would not have noticed either, because a view has no rows of its own to hash.
  //
  // The asymmetry with a function is deliberate and is asserted below: a replaced
  // function is `replaces-routine`, which releases without a rehearsal because
  // `pg_stat_user_functions` proves the new body was called. A view is selected from,
  // not called, so there is no such proof and a replaced view rehearses.

  it('calls a CREATE OR REPLACE VIEW of a view that already exists touches-existing', () => {
    const { status, stdout } = classifyOne('0002_view.sql', [
      '-- changes: existing_view',
      'CREATE OR REPLACE VIEW existing_view AS SELECT id, note FROM existing_table WHERE id > 0;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('touches-existing');
    // The deciding line names the file, the line number and the view.
    expect(stdout).toMatch(/0002_view\.sql:2 {2}CREATE OR REPLACE VIEW existing_view, which already exists/u);
  });

  it('keeps a CREATE OR REPLACE VIEW of a brand-new name additive', () => {
    const { status, stdout } = classifyOne('0002_view.sql', [
      '-- changes: none',
      'CREATE OR REPLACE VIEW never_seen_view AS SELECT id FROM existing_table;',
    ]);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('additive');
  });

  it('calls an ALTER VIEW of a view that already exists touches-existing', () => {
    const owner = classifyOne('0002_view_owner.sql', ['-- changes: existing_view', 'ALTER VIEW existing_view OWNER TO migration;']);
    expect(owner.status).toBe(0);
    expect(owner.stdout.split('\n')[0]).toBe('touches-existing');
    expect(owner.stdout).toContain('ALTER VIEW existing_view, which already exists');

    const options = classifyOne('0002_view_set.sql', [
      '-- changes: existing_view',
      'ALTER VIEW existing_view SET (security_barrier = true);',
    ]);
    expect(options.stdout.split('\n')[0]).toBe('touches-existing');
    expect(options.stdout).toContain('ALTER VIEW existing_view, which already exists');
  });

  it('keeps a DROP VIEW of a view that already exists destructive', () => {
    const { status, stdout } = classifyOne('0002_drop_view.sql', ['-- changes: existing_view', 'DROP VIEW existing_view;']);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('destructive');
    expect(stdout).toContain('DROP VIEW existing_view');

    const absent = classifyOne('0002_drop_view.sql', ['-- changes: none', 'DROP VIEW IF EXISTS never_existed_view;']);
    expect(absent.stdout.split('\n')[0]).toBe('additive');
  });

  it('calls a replacement of effective_suppressions that returns nothing touches-existing', () => {
    // The review's own case, reproduced inline rather than by pointing at the real
    // migration directory: a check that names another checkout passes on one machine
    // and fails on every other. The shape is 0006_policy.sql's — a view over
    // `suppression_events` that answers "is this handle suppressed?" — and the
    // replacement is the quiet disaster: same name, same columns, `WHERE false`.
    const { status, stdout } = classify(
      [
        [
          '0002_policy.sql',
          [
            '-- changes: none',
            'CREATE TABLE suppression_events (event_id uuid PRIMARY KEY, workspace_id uuid, scope text, canonical_key text);',
            'CREATE VIEW effective_suppressions AS',
            '  SELECT e.workspace_id, e.scope, e.canonical_key, e.event_id',
            '    FROM suppression_events e',
            '   WHERE e.supersedes_event_id IS NULL;',
            '',
          ].join('\n'),
        ],
        [
          '0003_quiet.sql',
          [
            '-- changes: none',
            'CREATE OR REPLACE VIEW effective_suppressions AS',
            '  SELECT e.workspace_id, e.scope, e.canonical_key, e.event_id',
            '    FROM suppression_events e',
            '   WHERE false;',
            '',
          ].join('\n'),
        ],
      ],
      '0003_quiet.sql',
    );
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe('touches-existing');
    expect(stdout).toContain('CREATE OR REPLACE VIEW effective_suppressions, which already exists');
  });

  it('calls a REFRESH MATERIALIZED VIEW touches-existing rather than letting it fall through', () => {
    // No materialized view exists in this corpus, so this is the promise rather than a
    // real case: whatever else a migration does to one, it must not reach `additive` by
    // matching nothing. A REFRESH rewrites stored rows; anything else stays unclassified.
    const refreshed = classifyOne('0002_refresh.sql', ['-- changes: none', 'REFRESH MATERIALIZED VIEW some_matview;']);
    expect(refreshed.stdout.split('\n')[0]).toBe('touches-existing');
    expect(refreshed.stdout).toContain('REFRESH MATERIALIZED VIEW some_matview');

    const clustered = classifyOne('0002_matview.sql', ['-- changes: none', 'CLUSTER some_matview USING some_matview_key;']);
    expect(clustered.stdout.split('\n')[0]).toBe('unclassified');
  });
});
