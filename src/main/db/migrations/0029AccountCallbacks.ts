import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

/**
 * Schema 29: the callback David promises on a call (design D13, his decision of
 * 17 Sep 2026). `pm_account_callbacks` holds one revisioned row per promised
 * callback: the firm, the business day it is due in the firm's local zone
 * (`due_on`, a plain YYYY-MM-DD date, never an instant), the human report that
 * created it (`source_command_id`), the note David typed, and the state
 * `open | done | cancelled`. Marking one done or cancelled bumps the revision in
 * place; a trigger keeps the revision strictly monotonic and the firm, due date
 * and source command immutable, and nothing deletes a row. Additive only: no
 * existing table, index or trigger changes.
 */
const accountCallbackStatements = [
  `CREATE TABLE pm_account_callbacks (id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 255),
        account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        due_on TEXT NOT NULL CHECK(due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        note TEXT NULL CHECK(note IS NULL OR length(note) BETWEEN 1 AND 10000),
        state TEXT NOT NULL CHECK(state IN ('open','done','cancelled')),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
        source_command_id TEXT NOT NULL CHECK(length(source_command_id) BETWEEN 1 AND 255),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL CHECK(updated_at>=created_at))`,
  `CREATE INDEX pm_account_callbacks_due ON pm_account_callbacks(due_on,account_id)`,
  `CREATE TRIGGER pm_account_callbacks_no_delete BEFORE DELETE ON pm_account_callbacks BEGIN SELECT RAISE(ABORT,'Account callback history is immutable'); END`,
  `CREATE TRIGGER pm_account_callbacks_revision BEFORE UPDATE ON pm_account_callbacks
        WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.due_on IS NOT OLD.due_on
          OR NEW.source_command_id IS NOT OLD.source_command_id OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<>OLD.revision+1
        BEGIN SELECT RAISE(ABORT,'Account callback revision is monotonic'); END`,
] as const;

export const migration0029AccountCallbacks = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of accountCallbackStatements) await sql.raw(statement).execute(db);
    await sql`UPDATE app_meta SET schema_version=29,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};
