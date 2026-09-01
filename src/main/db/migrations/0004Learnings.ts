import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

const learningsStatements = [
  `CREATE TABLE learnings (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN (
      'pain','objection','alternative','winning_language','pricing_reaction',
      'product_request','coaching','invalidated_assumption'
    )),
    statement TEXT NOT NULL CHECK (length(trim(statement)) > 0),
    status TEXT NOT NULL CHECK (status IN ('active','contradicted','retired')),
    status_reason TEXT,
    confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
    contradiction_of TEXT REFERENCES learnings(id),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (status = 'contradicted' AND status_reason IS NOT NULL)
      OR (status <> 'contradicted')
    )
  )`,
  `CREATE TABLE learning_evidence (
    id TEXT PRIMARY KEY,
    learning_id TEXT NOT NULL REFERENCES learnings(id),
    person_id TEXT REFERENCES persons(id),
    activity_id TEXT,
    quote TEXT NOT NULL CHECK (length(trim(quote)) > 0),
    noted_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (activity_id, person_id) REFERENCES activities(id, person_id)
  )`,
  `CREATE INDEX learning_evidence_learning_idx
    ON learning_evidence(learning_id, noted_at)`,
  `CREATE TRIGGER protect_learning_identity
    BEFORE UPDATE OF id, category, statement, contradiction_of, created_at
      ON learnings
    WHEN NEW.id IS NOT OLD.id
      OR NEW.category IS NOT OLD.category
      OR NEW.statement IS NOT OLD.statement
      OR NEW.contradiction_of IS NOT OLD.contradiction_of
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'learning statement and lineage are immutable');
    END`,
  `CREATE TRIGGER protect_learning_delete
    BEFORE DELETE ON learnings
    BEGIN
      SELECT RAISE(ABORT, 'learnings are retained permanently; retire instead');
    END`,
  `CREATE TRIGGER immutable_learning_evidence
    BEFORE UPDATE ON learning_evidence
    BEGIN
      SELECT RAISE(ABORT, 'learning_evidence rows are immutable');
    END`,
  `CREATE TRIGGER immutable_learning_evidence_delete
    BEFORE DELETE ON learning_evidence
    BEGIN
      SELECT RAISE(ABORT, 'learning_evidence rows are immutable');
    END`,
] as const;

export const migration0004Learnings = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of learningsStatements) {
      await sql.raw(statement).execute(db);
    }

    const timestamp = new Date().toISOString();
    await sql`
      UPDATE app_meta
      SET schema_version = 4, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};
