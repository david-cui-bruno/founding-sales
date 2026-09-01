import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';
import { normalizeCloudDisplayName } from '../../domain/source/cloudNameMatching';
import {
  serializeCanonicalIntakeResult,
  type StoredIntakeResult,
} from '../../domain/source/intakeReceiptRepository';

/**
 * Data repair for the cloud duplicate-person bug (schema 8).
 *
 * Before the cloud-entity-link-first matching fix, every contact-less cloud
 * event minted a fresh person, so one live poll created up to three "212 LLC"
 * rows. This migration merges cloud-linked persons that share an identical
 * normalized display name (the same normalization the runtime matcher uses)
 * into the person with the LOWEST created_at:
 *
 * - cloud_entity_links, source_events, source_intake_receipts (including the
 *   canonical result_json payload), and trigger_events repoint to the
 *   surviving person and its single earliest prospect;
 * - context links (prospect_organizations / prospect_properties) move over;
 * - the duplicate's cloud score is preserved on the survivor when newer;
 * - the duplicate person and its now-empty prospect/cycle/actions/stage
 *   events are deleted, but ONLY when the duplicate carries no
 *   founder-generated data (no activities/conversations, no learnings
 *   evidence, no consent records, no opt-out state, untouched unreviewed
 *   cycle). Anything dirty is left alone: duplicates are recoverable,
 *   wrong merges are not.
 *
 * Immutability triggers forbid the UPDATE/DELETE repairs, so exactly like
 * 0005 they are dropped and recreated verbatim around the repair inside the
 * runner's single transaction, and `PRAGMA foreign_key_check` proves the
 * graph is whole before commit.
 */

type CloudLinkedPersonRow = {
  id: string;
  display_name: string;
  created_at: string;
  opted_out: number;
};

type MergePlan = {
  canonicalPersonId: string;
  canonicalProspectId: string;
  duplicatePersonId: string;
  duplicateProspectId: string | null;
  duplicateCycleIds: string[];
};

/** Trigger name -> exact recreation DDL (0002/0005 text, verbatim). */
const REPAIR_TRIGGERS: Record<string, string> = {
  immutable_source_events: `CREATE TRIGGER immutable_source_events
    BEFORE UPDATE ON source_events
    BEGIN
      SELECT RAISE(ABORT, 'source_events rows are immutable');
    END`,
  immutable_source_intake_receipts: `CREATE TRIGGER immutable_source_intake_receipts
    BEFORE UPDATE ON source_intake_receipts
    BEGIN
      SELECT RAISE(ABORT, 'source_intake_receipts rows are immutable');
    END`,
  immutable_trigger_events: `CREATE TRIGGER immutable_trigger_events
      BEFORE UPDATE ON trigger_events
      BEGIN
        SELECT RAISE(ABORT, 'trigger_events rows are immutable');
      END`,
  immutable_stage_events_delete: `CREATE TRIGGER immutable_stage_events_delete
      BEFORE DELETE ON stage_events
      BEGIN
        SELECT RAISE(ABORT, 'stage_events rows are immutable');
      END`,
  immutable_prioritization_evaluations_delete: `CREATE TRIGGER immutable_prioritization_evaluations_delete
      BEFORE DELETE ON prioritization_evaluations
      BEGIN
        SELECT RAISE(ABORT, 'prioritization_evaluations rows are immutable');
      END`,
  protect_next_action_delete: `CREATE TRIGGER protect_next_action_delete
    BEFORE DELETE ON next_actions
    BEGIN
      SELECT RAISE(ABORT, 'next actions are retained permanently');
    END`,
};

export const migration0008DedupeCloudPersons = {
  async up(db: Kysely<FoundationDatabase>) {
    // The migration runner holds one BEGIN IMMEDIATE transaction around
    // every pending migration; deferred foreign keys reset at commit.
    await sql.raw('PRAGMA defer_foreign_keys = ON').execute(db);

    const merges = await planMerges(db);

    if (merges.length > 0) {
      for (const name of Object.keys(REPAIR_TRIGGERS)) {
        await sql.raw(`DROP TRIGGER ${name}`).execute(db);
      }
      for (const merge of merges) {
        await mergeDuplicate(db, merge);
      }
      for (const create of Object.values(REPAIR_TRIGGERS)) {
        await sql.raw(create).execute(db);
      }
    }

    const violations = await sql.raw('PRAGMA foreign_key_check').execute(db);
    if (violations.rows.length > 0) {
      throw new Error('The cloud person dedupe left dangling foreign keys.');
    }

    const timestamp = new Date().toISOString();
    await sql`
      UPDATE app_meta
      SET schema_version = 8, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};

async function planMerges(db: Kysely<FoundationDatabase>): Promise<MergePlan[]> {
  const persons = (await sql<CloudLinkedPersonRow>`
    SELECT DISTINCT person.id, person.display_name, person.created_at,
      person.opted_out
    FROM persons AS person
    JOIN cloud_entity_links AS link ON link.person_id = person.id
    WHERE person.deleted_at IS NULL
    ORDER BY person.created_at ASC, person.id ASC
  `.execute(db)).rows;

  const groups = new Map<string, CloudLinkedPersonRow[]>();
  for (const person of persons) {
    const key = normalizeCloudDisplayName(person.display_name);
    if (key.length === 0) continue;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [person]);
    } else {
      group.push(person);
    }
  }

  const merges: MergePlan[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // The SELECT is ordered created_at ASC, id ASC: first row is canonical.
    const [canonical, ...duplicates] = group;
    if (canonical === undefined) continue;
    // Merging INTO an opted-out person would fight the opt-out triggers
    // (frozen contact surface); leave such groups for manual review.
    if (canonical.opted_out !== 0) continue;
    const canonicalProspectId = await prospectIdOf(db, canonical.id);
    if (canonicalProspectId === null) continue;
    for (const duplicate of duplicates) {
      if (await hasFounderGeneratedData(db, duplicate)) continue;
      merges.push({
        canonicalPersonId: canonical.id,
        canonicalProspectId,
        duplicatePersonId: duplicate.id,
        duplicateProspectId: await prospectIdOf(db, duplicate.id),
        duplicateCycleIds: (await sql<{ id: string }>`
          SELECT id FROM sales_cycles WHERE person_id = ${duplicate.id}
        `.execute(db)).rows.map((row) => row.id),
      });
    }
  }
  return merges;
}

async function prospectIdOf(
  db: Kysely<FoundationDatabase>,
  personId: string,
): Promise<string | null> {
  const rows = (await sql<{ id: string }>`
    SELECT id FROM prospects WHERE person_id = ${personId}
  `.execute(db)).rows;
  return rows[0]?.id ?? null;
}

/**
 * A duplicate is only deletable when the founder never touched it: no
 * activities (conversations attach to activities), no learnings evidence,
 * no consent/opt-out state, no referrals pointing at it, and nothing but
 * the untouched mechanical Unreviewed cycle.
 */
async function hasFounderGeneratedData(
  db: Kysely<FoundationDatabase>,
  duplicate: CloudLinkedPersonRow,
): Promise<boolean> {
  if (duplicate.opted_out !== 0) return true;
  const personId = duplicate.id;
  const personChecks = [
    sql`SELECT 1 AS hit FROM activities WHERE person_id = ${personId} LIMIT 1`,
    sql`SELECT 1 AS hit FROM learning_evidence WHERE person_id = ${personId} LIMIT 1`,
    sql`SELECT 1 AS hit FROM consent_policy_records WHERE person_id = ${personId} LIMIT 1`,
    sql`SELECT 1 AS hit FROM opt_out_tombstones WHERE person_id = ${personId} LIMIT 1`,
    sql`SELECT 1 AS hit FROM opt_out_closure_receipts WHERE person_id = ${personId} LIMIT 1`,
    sql`SELECT 1 AS hit FROM cycle_reactivation_receipts WHERE person_id = ${personId} LIMIT 1`,
    sql`SELECT 1 AS hit FROM lifecycle_review_items WHERE person_id = ${personId} LIMIT 1`,
    sql`SELECT 1 AS hit FROM source_events WHERE referred_by_person_id = ${personId} LIMIT 1`,
    sql`
      SELECT 1 AS hit FROM source_events
      WHERE person_id = ${personId} AND sales_cycle_id IS NOT NULL
      LIMIT 1
    `,
    sql`
      SELECT 1 AS hit FROM sales_cycles
      WHERE person_id = ${personId}
        AND (stage <> 'unreviewed' OR workflow_status <> 'active')
      LIMIT 1
    `,
    sql`
      SELECT 1 AS hit FROM cadence_enrollments
      WHERE sales_cycle_id IN (
        SELECT id FROM sales_cycles WHERE person_id = ${personId}
      )
      LIMIT 1
    `,
    sql`
      SELECT 1 AS hit FROM next_actions
      WHERE sales_cycle_id IN (
        SELECT id FROM sales_cycles WHERE person_id = ${personId}
      )
        AND status <> 'pending'
      LIMIT 1
    `,
    sql`
      SELECT 1 AS hit FROM stage_events
      WHERE sales_cycle_id IN (
        SELECT id FROM sales_cycles WHERE person_id = ${personId}
      )
        AND confirmation_kind <> 'mechanical'
      LIMIT 1
    `,
    sql`
      SELECT 1 AS hit FROM sales_cycle_close_readiness
      WHERE sales_cycle_id IN (
        SELECT id FROM sales_cycles WHERE person_id = ${personId}
      )
      LIMIT 1
    `,
    sql`
      SELECT 1 AS hit FROM priority_overrides
      WHERE prospect_id IN (SELECT id FROM prospects WHERE person_id = ${personId})
      LIMIT 1
    `,
    sql`
      SELECT 1 AS hit FROM prioritization_preference_events
      WHERE winner_prospect_id IN (
          SELECT id FROM prospects WHERE person_id = ${personId}
        )
        OR loser_prospect_id IN (
          SELECT id FROM prospects WHERE person_id = ${personId}
        )
        OR controlled_prospect_id IN (
          SELECT id FROM prospects WHERE person_id = ${personId}
        )
      LIMIT 1
    `,
  ];
  for (const check of personChecks) {
    const { rows } = await check.execute(db);
    if (rows.length > 0) return true;
  }
  return false;
}

async function mergeDuplicate(
  db: Kysely<FoundationDatabase>,
  merge: MergePlan,
): Promise<void> {
  const {
    canonicalPersonId, canonicalProspectId, duplicatePersonId,
    duplicateProspectId, duplicateCycleIds,
  } = merge;

  // 1. Cloud entity links converge on the survivor (PK is cloud_entity_id,
  //    so many links -> one person is fine by design).
  await sql`
    UPDATE cloud_entity_links
    SET person_id = ${canonicalPersonId}
    WHERE person_id = ${duplicatePersonId}
  `.execute(db);

  // 2. Immutable source events repoint to the survivor and its prospect.
  await sql`
    UPDATE source_events
    SET person_id = ${canonicalPersonId},
        prospect_id = CASE
          WHEN prospect_id IS NULL THEN NULL
          ELSE ${canonicalProspectId}
        END
    WHERE person_id = ${duplicatePersonId}
  `.execute(db);

  // 3. Receipts repoint, including the canonical result_json payload so the
  //    receipt repository's read-time integrity checks keep passing and
  //    applyCloudScoreUpdate keeps finding the prospect by receipt key.
  const receipts = (await sql<{ source_event_id: string; result_json: string }>`
    SELECT source_event_id, result_json
    FROM source_intake_receipts
    WHERE person_id = ${duplicatePersonId}
  `.execute(db)).rows;
  for (const receipt of receipts) {
    const envelope = JSON.parse(receipt.result_json) as {
      formatVersion: 1;
      result: StoredIntakeResult;
    };
    const result: StoredIntakeResult = {
      ...envelope.result,
      personId: canonicalPersonId,
      prospectId: canonicalProspectId,
    };
    await sql`
      UPDATE source_intake_receipts
      SET person_id = ${canonicalPersonId},
          prospect_id = ${canonicalProspectId},
          result_json = ${serializeCanonicalIntakeResult(result)}
      WHERE source_event_id = ${receipt.source_event_id}
    `.execute(db);
  }

  if (duplicateProspectId !== null) {
    // 4. Immutable trigger events repoint to the surviving prospect.
    await sql`
      UPDATE trigger_events
      SET prospect_id = ${canonicalProspectId}
      WHERE prospect_id = ${duplicateProspectId}
    `.execute(db);

    // 5. Context links move over; identical links deduplicate on the PK.
    await sql`
      INSERT OR IGNORE INTO prospect_organizations (
        prospect_id, organization_id, relationship, created_at
      )
      SELECT ${canonicalProspectId}, organization_id, relationship, created_at
      FROM prospect_organizations
      WHERE prospect_id = ${duplicateProspectId}
    `.execute(db);
    await sql`
      DELETE FROM prospect_organizations WHERE prospect_id = ${duplicateProspectId}
    `.execute(db);
    await sql`
      INSERT OR IGNORE INTO prospect_properties (
        prospect_id, property_id, relationship, created_at
      )
      SELECT ${canonicalProspectId}, property_id, relationship, created_at
      FROM prospect_properties
      WHERE prospect_id = ${duplicateProspectId}
    `.execute(db);
    await sql`
      DELETE FROM prospect_properties WHERE prospect_id = ${duplicateProspectId}
    `.execute(db);

    // 6. Preserve the newest cloud score on the survivor.
    await sql`
      UPDATE prospects
      SET cloud_fit = duplicate.cloud_fit,
          cloud_timing = duplicate.cloud_timing,
          cloud_score_reasons_json = duplicate.cloud_score_reasons_json,
          cloud_scores_version = duplicate.cloud_scores_version,
          cloud_scored_at = duplicate.cloud_scored_at
      FROM (
        SELECT cloud_fit, cloud_timing, cloud_score_reasons_json,
          cloud_scores_version, cloud_scored_at
        FROM prospects
        WHERE id = ${duplicateProspectId}
      ) AS duplicate
      WHERE prospects.id = ${canonicalProspectId}
        AND duplicate.cloud_scores_version IS NOT NULL
        AND (
          prospects.cloud_scores_version IS NULL
          OR prospects.cloud_scores_version < duplicate.cloud_scores_version
        )
    `.execute(db);

    // 7. Derived scoring artifacts of the duplicate prospect are dropped;
    //    they are reproducible projections, not founder evidence.
    await sql`
      DELETE FROM prospect_priority_projection
      WHERE prospect_id = ${duplicateProspectId}
    `.execute(db);
    await sql`
      DELETE FROM prioritization_evaluations
      WHERE prospect_id = ${duplicateProspectId}
    `.execute(db);
  }

  // 8. The duplicate's mechanical Unreviewed cycle disappears whole. The
  //    guard proved there is nothing founder-generated underneath.
  for (const cycleId of duplicateCycleIds) {
    await sql`DELETE FROM stage_events WHERE sales_cycle_id = ${cycleId}`.execute(db);
    await sql`DELETE FROM sales_cycles WHERE id = ${cycleId}`.execute(db);
    await sql`DELETE FROM next_actions WHERE sales_cycle_id = ${cycleId}`.execute(db);
  }

  // 9. Contact handles (rare for public records) move to the survivor when
  //    it lacks them; is_primary drops so the survivor's primaries win.
  await sql`
    UPDATE person_contact_methods
    SET person_id = ${canonicalPersonId}, is_primary = 0
    WHERE person_id = ${duplicatePersonId}
      AND NOT EXISTS (
        SELECT 1 FROM person_contact_methods AS existing
        WHERE existing.person_id = ${canonicalPersonId}
          AND existing.kind = person_contact_methods.kind
          AND existing.normalized_value = person_contact_methods.normalized_value
      )
  `.execute(db);
  await sql`
    DELETE FROM person_contact_methods WHERE person_id = ${duplicatePersonId}
  `.execute(db);

  // 10. Exactly one prospect per person survives; the duplicate rows go.
  if (duplicateProspectId !== null) {
    await sql`DELETE FROM prospects WHERE id = ${duplicateProspectId}`.execute(db);
  }
  await sql`DELETE FROM persons WHERE id = ${duplicatePersonId}`.execute(db);
}
