import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';
export const migration0026LocalCompanyDrafts = {
  async up(db: Kysely<FoundationDatabase>) {
    const statements = [
      `CREATE TABLE local_company_email_drafts (id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES pm_accounts(id),
        route_id TEXT NOT NULL, route_version INTEGER NOT NULL, email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(trim(email))),
        kind TEXT NOT NULL CHECK(kind='local_company_email'), status TEXT NOT NULL CHECK(status='unsent'),
        account_version_at_open INTEGER NOT NULL CHECK(account_version_at_open>0), company_label TEXT NOT NULL CHECK(length(company_label) BETWEEN 1 AND 300),
        source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json) AND json_type(source_ids_json)='array' AND length(source_ids_json)<=128000),
        publication_json TEXT NOT NULL CHECK(json_valid(publication_json) AND json_type(publication_json)='object' AND length(publication_json)<=96000),
        subject TEXT NOT NULL CHECK(length(subject)<=240 AND instr(subject,char(0))=0 AND instr(subject,char(10))=0 AND instr(subject,char(13))=0),
        body TEXT NOT NULL CHECK(length(body)<=20000 AND instr(body,char(0))=0), revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL CHECK(updated_at>=created_at), UNIQUE(account_id,id), UNIQUE(account_id,route_id,route_version),
        FOREIGN KEY(account_id,route_id,route_version) REFERENCES pm_account_routes(account_id,id,version))`,
      `CREATE TABLE local_company_draft_commands (command_id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, draft_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('open','save')), fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
        applied_revision INTEGER NOT NULL CHECK(applied_revision>0), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json)<=100000),
        created_at TEXT NOT NULL, FOREIGN KEY(account_id,draft_id) REFERENCES local_company_email_drafts(account_id,id))`,
      `CREATE TRIGGER local_company_draft_binding_immutable BEFORE UPDATE ON local_company_email_drafts WHEN
        NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.route_id IS NOT OLD.route_id OR NEW.route_version IS NOT OLD.route_version
        OR NEW.email IS NOT OLD.email OR NEW.kind IS NOT OLD.kind OR NEW.status IS NOT OLD.status OR NEW.account_version_at_open IS NOT OLD.account_version_at_open
        OR NEW.company_label IS NOT OLD.company_label OR NEW.source_ids_json IS NOT OLD.source_ids_json OR NEW.publication_json IS NOT OLD.publication_json
        OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<>OLD.revision+1
        BEGIN SELECT RAISE(ABORT,'Company draft binding is immutable'); END`,
      ...['local_company_email_drafts', 'local_company_draft_commands'].map(table =>
        `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Company draft history is immutable'); END`),
      `CREATE TRIGGER local_company_draft_commands_no_update BEFORE UPDATE ON local_company_draft_commands BEGIN SELECT RAISE(ABORT,'Company draft receipt is immutable'); END`,
    ];
    for (const statement of statements) await sql.raw(statement).execute(db);
    await sql`UPDATE app_meta SET schema_version=26,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};
