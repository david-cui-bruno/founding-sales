import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

/** Account-owned mail persistence, separate from legacy person/cycle drafts. */
export const migration0022MailPersistence = {
  async up(db: Kysely<FoundationDatabase>) {
    await sql`CREATE TABLE delegated_mail_cursors (
      workspace_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id), mailbox_subject TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json)),
      revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991), updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,account_id,mailbox_subject))`.execute(db);
    await sql`CREATE TABLE delegated_reply_drafts (
      workspace_id TEXT NOT NULL, account_id TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
      thread_revision INTEGER NOT NULL CHECK(thread_revision BETWEEN 1 AND 9007199254740991), context_revision TEXT NOT NULL,
      draft_json TEXT NOT NULL CHECK(json_valid(draft_json)), updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,account_id,id),
      FOREIGN KEY(workspace_id,account_id,thread_id) REFERENCES delegated_threads(workspace_id,account_id,id))`.execute(db);
    await sql`UPDATE app_meta SET schema_version=22,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};
