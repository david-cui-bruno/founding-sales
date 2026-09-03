import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

/**
 * Upstream request state (schema 12): suppression outbox + enrichment
 * request rate-limit ledger.
 *
 * `sourcing_suppression_outbox` is the exactly-once flush marker for
 * opt-out tombstone handles flowing app -> cloud as salted HMAC lines in
 * upstream/suppressions/<date>.ndjson (suppressionUploadLineSchema). One
 * row per opt_out_handles row, keyed by the handle id; a row is marked
 * flushed only after its upload succeeded, so a failed run retries.
 *
 * `sourcing_enrichment_requests` records the last time a "Find contact
 * info" enrichment request was written for a cloud entity, enforcing the
 * 30-day per-entity rate limit (no bulk enrichment, ever).
 */
const upstreamRequestStateStatements = [
  `CREATE TABLE sourcing_suppression_outbox (
    handle_id TEXT PRIMARY KEY REFERENCES opt_out_handles(id),
    flushed_at TEXT NULL
  )`,
  `CREATE TABLE sourcing_enrichment_requests (
    cloud_entity_id TEXT PRIMARY KEY,
    last_requested_at TEXT NOT NULL
  )`,
] as const;

export const migration0012UpstreamRequestState = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of upstreamRequestStateStatements) {
      await sql.raw(statement).execute(db);
    }

    const timestamp = new Date().toISOString();
    await sql`
      UPDATE app_meta
      SET schema_version = 12, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};
