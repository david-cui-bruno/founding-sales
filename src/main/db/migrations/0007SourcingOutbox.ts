import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

/**
 * Upstream sync state (plan Task 4) plus the Task 5 cloud-score columns.
 *
 * `sourcing_outcome_outbox` is the local durable queue of outcome labels
 * flowing app -> cloud keyed by cloud_entity_id ONLY (CONTRACT.md upstream
 * section: no names, no notes, no free text). `label` and
 * `override_direction` are closed enums; `loss_reason_code` carries the
 * CRM's existing Lost-Nurture reason codes and is validated again by the
 * strict zod upload schema before anything leaves the machine.
 *
 * The prospect cloud-score columns store the scorer's fit/timing axes and
 * top-3 reasons verbatim. They stay separate columns by design: the app
 * never blends fit and timing into one number.
 */
const sourcingOutboxStatements = [
  `CREATE TABLE sourcing_outcome_outbox (
    id TEXT PRIMARY KEY,
    cloud_entity_id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN ('interviewed','offered','won','lost','override')),
    loss_reason_code TEXT NULL,
    override_direction TEXT NULL CHECK (override_direction IN ('up','down')),
    observed_at TEXT NOT NULL,
    flushed_at TEXT NULL,
    CHECK (
      (label = 'override' AND override_direction IS NOT NULL)
      OR (label <> 'override' AND override_direction IS NULL)
    )
  )`,
  `ALTER TABLE prospects ADD COLUMN cloud_fit INTEGER`,
  `ALTER TABLE prospects ADD COLUMN cloud_timing INTEGER`,
  `ALTER TABLE prospects ADD COLUMN cloud_score_reasons_json TEXT`,
  `ALTER TABLE prospects ADD COLUMN cloud_scores_version INTEGER`,
  `ALTER TABLE prospects ADD COLUMN cloud_scored_at TEXT`,
] as const;

export const migration0007SourcingOutbox = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of sourcingOutboxStatements) {
      await sql.raw(statement).execute(db);
    }

    const timestamp = new Date().toISOString();
    await sql`
      UPDATE app_meta
      SET schema_version = 7, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};
