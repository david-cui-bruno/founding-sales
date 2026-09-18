import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';
import { REPLY_TEMPLATE_PURPOSES } from '../../../shared/contracts/replyTemplateContract';
import { seededReplyTemplates } from '../../outreach/templates/replyTemplateSeeds';

/**
 * Schema 30: the five follow-up templates David approves once (design D13, his decision of 17 Sep 2026).
 * `email_templates` holds one revisioned row per template: the text he edits (`subject`, `body`), the
 * variables it names (`variables_json`), and the standing approval beside it (`approval_state`,
 * `approved_revision`, `approved_at`, `content_hash`). Editing the text bumps the revision by one and the
 * repository returns the row to `revoked`; approving leaves the revision alone and records the sha256 of
 * exactly that revision. A trigger keeps the revision monotonic, freezes the id, purpose and creation time,
 * and refuses a same-revision update that changed the text; nothing deletes a row.
 *
 * `email_template_settings` is the singleton "Pause all sends" switch, revisioned the same way, so pausing
 * holds every template without revoking a single approval David gave.
 *
 * The migration seeds T1 to T5 as `draft` with the exact text of the 17 September templates file, read from
 * `replyTemplateSeeds.ts` and checked against the sha256 pinned there, so this migration cannot drift with a
 * later edit to that text. **A migration never approves anything**: every seeded row is a draft, no owner
 * command is queued, and the worker learns nothing until David presses Approve in Settings.
 *
 * Additive only: no existing table, index or trigger is dropped, rebuilt or altered.
 */
const emailTemplateStatements = [
  `CREATE TABLE email_templates (id TEXT PRIMARY KEY NOT NULL CHECK(id IN ('T1','T2','T3','T4','T5')),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
        purpose TEXT NOT NULL CHECK(purpose IN (${REPLY_TEMPLATE_PURPOSES.map(purpose => `'${purpose}'`).join(',')})),
        subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 160),
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
        variables_json TEXT NOT NULL CHECK(json_valid(variables_json) AND json_type(variables_json)='array' AND length(variables_json)<=400),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
        approval_state TEXT NOT NULL CHECK(approval_state IN ('draft','approved','revoked')),
        approved_revision INTEGER NULL CHECK(approved_revision IS NULL OR (typeof(approved_revision)='integer' AND approved_revision BETWEEN 1 AND 9007199254740991)),
        approved_at TEXT NULL,
        content_hash TEXT NULL CHECK(content_hash IS NULL OR (length(content_hash)=64 AND content_hash GLOB '[0-9a-f]*')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL CHECK(updated_at>=created_at),
        CHECK((approval_state='approved')=(approved_revision IS NOT NULL)),
        CHECK((approved_revision IS NULL)=(approved_at IS NULL)),
        CHECK((approved_revision IS NULL)=(content_hash IS NULL)),
        CHECK(approved_revision IS NULL OR approved_revision<=revision))`,
  `CREATE TRIGGER email_templates_no_delete BEFORE DELETE ON email_templates BEGIN SELECT RAISE(ABORT,'Email template history is immutable'); END`,
  `CREATE TRIGGER email_templates_revision BEFORE UPDATE ON email_templates
        WHEN NEW.id IS NOT OLD.id OR NEW.purpose IS NOT OLD.purpose OR NEW.created_at IS NOT OLD.created_at
          OR NEW.revision<OLD.revision OR NEW.revision>OLD.revision+1
          OR (NEW.revision=OLD.revision AND (NEW.subject IS NOT OLD.subject OR NEW.body IS NOT OLD.body OR NEW.variables_json IS NOT OLD.variables_json))
        BEGIN SELECT RAISE(ABORT,'Email template revision is monotonic'); END`,
  `CREATE TABLE email_template_settings (singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
        paused INTEGER NOT NULL CHECK(paused IN (0,1)),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
        updated_at TEXT NOT NULL)`,
  `CREATE TRIGGER email_template_settings_no_delete BEFORE DELETE ON email_template_settings BEGIN SELECT RAISE(ABORT,'Email template settings history is immutable'); END`,
  `CREATE TRIGGER email_template_settings_revision BEFORE UPDATE ON email_template_settings
        WHEN NEW.singleton IS NOT OLD.singleton OR NEW.revision<>OLD.revision+1
        BEGIN SELECT RAISE(ABORT,'Email template settings revision is monotonic'); END`,
] as const;

export const migration0030EmailTemplates = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of emailTemplateStatements) await sql.raw(statement).execute(db);
    const seededAt = new Date().toISOString();
    for (const template of seededReplyTemplates(seededAt)) {
      await sql`INSERT INTO email_templates(id,name,purpose,subject,body,variables_json,revision,approval_state,approved_revision,approved_at,content_hash,created_at,updated_at)
        VALUES(${template.id},${template.name},${template.purpose},${template.subject},${template.body},${JSON.stringify(template.variables)},
          ${template.revision},'draft',NULL,NULL,NULL,${seededAt},${seededAt})`.execute(db);
    }
    await sql`INSERT INTO email_template_settings(singleton,paused,revision,updated_at) VALUES(1,0,1,${seededAt})`.execute(db);
    await sql`UPDATE app_meta SET schema_version=30,updated_at=${seededAt} WHERE singleton=1`.execute(db);
  },
};
