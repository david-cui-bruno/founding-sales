import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

/** Forward-only local draft storage. Intents/results are immutable legal evidence. */
export const migration0019EmailDrafts = {
  async up(db: Kysely<FoundationDatabase>) {
    const statements = [
      `CREATE TABLE email_drafts (
        id TEXT PRIMARY KEY NOT NULL, person_id TEXT NOT NULL REFERENCES persons(id),
        sales_cycle_id TEXT NOT NULL REFERENCES sales_cycles(id),
        contact_method_id TEXT NOT NULL REFERENCES person_contact_methods(id),
        recipient TEXT NOT NULL, contact_snapshot TEXT NOT NULL CHECK(length(contact_snapshot)=64),
        account_email TEXT, sender_footer TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL CHECK(length(subject)<=240 AND instr(subject,char(10))=0 AND instr(subject,char(13))=0),
        body TEXT NOT NULL CHECK(length(body)<=20000), revision INTEGER NOT NULL CHECK(revision>0),
        status TEXT NOT NULL CHECK(status IN ('draft','sending','sent','unknown')),
        generation TEXT NOT NULL CHECK(generation IN ('none','model','edited')),
        message_id TEXT, notice TEXT, superseded_at TEXT CHECK(superseded_at IS NULL OR status='draft'), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(sales_cycle_id,person_id) REFERENCES sales_cycles(id,person_id)
      )`,
      `CREATE UNIQUE INDEX email_draft_open_contact ON email_drafts(sales_cycle_id,contact_method_id) WHERE status <> 'sent' AND superseded_at IS NULL`,
      `CREATE TABLE email_send_intents (
        command_id TEXT PRIMARY KEY NOT NULL, draft_id TEXT NOT NULL REFERENCES email_drafts(id),
        draft_revision INTEGER NOT NULL CHECK(draft_revision>0), content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
        reservation_json TEXT NOT NULL CHECK(json_valid(reservation_json)), created_at TEXT NOT NULL,
        UNIQUE(draft_id,draft_revision)
      )`,
      `CREATE TABLE email_send_results (
        command_id TEXT PRIMARY KEY NOT NULL REFERENCES email_send_intents(command_id),
        status TEXT NOT NULL CHECK(status IN ('accepted','not_sent','unknown')),
        result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL
      )`,
      ...['email_send_intents','email_send_results'].flatMap(table => ['UPDATE','DELETE'].map(operation =>
        `CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
         BEGIN SELECT RAISE(ABORT, 'Email evidence is immutable'); END`)),
    ];
    for (const statement of statements) await sql.raw(statement).execute(db);
    await sql`UPDATE app_meta SET schema_version=19,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};
