import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';
export const migration0025KnownCompanyResearchSettings = {
  async up(db: Kysely<FoundationDatabase>) {
    await sql.raw(`ALTER TABLE workspace_settings ADD COLUMN known_company_research_json TEXT CHECK(known_company_research_json IS NULL OR (json_valid(known_company_research_json) AND json_type(known_company_research_json)='object'))`).execute(db);
    await sql.raw(`ALTER TABLE workspace_settings ADD COLUMN known_company_research_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(known_company_research_revision)='integer' AND known_company_research_revision BETWEEN 0 AND 9007199254740991)`).execute(db);
    await sql`UPDATE app_meta SET schema_version=25,updated_at=${new Date().toISOString()} WHERE singleton=1`.execute(db);
  },
};
