import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

/**
 * Processed-file ledger for the sourcing poller (schema 9).
 *
 * The single lexicographic cursor (`sourcing_cursor.last_key`) silently lost
 * inbox files: any key sorting BEFORE the stored cursor was skipped forever.
 * This happened live when repair copies named `events/.../zz-repair-*.ndjson`
 * were consumed, leaving the cursor pointing past normal same-day files
 * (`mail-parse-*`, `scorer-*`) created later. Same-day ordering anomalies
 * (clock skew between lambdas, manual repairs) are a standing hazard, so
 * progress is now defined by an explicit per-file ledger instead of a cursor.
 *
 * The stored cursor resets to NULL so the next poll re-reads the whole inbox.
 * That full re-read is safe: intake receipts (`cloud:<idempotency_key>`) make
 * replayed imports no-ops and score updates are idempotent by receipt key, so
 * every already-processed event lands as a replay, not a duplicate. The
 * cursor row itself stays (the status row still shows freshness); the poller
 * keeps writing the max processed key into it.
 */
const sourcingFileLedgerStatements = [
  `CREATE TABLE sourcing_processed_files (
    key TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL
  )`,
  `UPDATE sourcing_cursor SET last_key = NULL`,
] as const;

export const migration0009SourcingFileLedger = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of sourcingFileLedgerStatements) {
      await sql.raw(statement).execute(db);
    }

    const timestamp = new Date().toISOString();
    await sql`
      UPDATE app_meta
      SET schema_version = 9, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};
