import { sql, type Kysely } from 'kysely';
import type { FoundationDatabase } from '../schema';

/** Forward-only restoration of the approved playbook. Never reconstruct a
 * deleted historical deadline as fact. Legacy created_at fallback is explicitly
 * labelled unscheduled; recorded resurfacing dates retain their provenance.
 * Supplemental rows remain historical/non-authoritative, never deleted. */
export const migration0018PlaybookDueActions = {
  async up(db: Kysely<FoundationDatabase>) {
    const statements = [
      `ALTER TABLE next_actions ADD COLUMN due_at TEXT CHECK (due_at IS NULL OR
        (length(due_at) = 24 AND julianday(due_at) IS NOT NULL AND substr(due_at, 24) = 'Z'))`,
      `ALTER TABLE next_actions ADD COLUMN due_source TEXT NOT NULL DEFAULT 'legacy_unscheduled'
        CHECK (due_source IN ('legacy_unscheduled','recorded_callback','founder_resurface','playbook_v1','internal_review'))`,
      `UPDATE next_actions SET due_at = COALESCE((SELECT resurface_at FROM sales_cycles c
          WHERE c.current_next_action_id = next_actions.id), created_at),
        due_source = CASE WHEN EXISTS (SELECT 1 FROM sales_cycles c WHERE c.current_next_action_id = next_actions.id
          AND c.resurface_reason = 'callback' AND EXISTS (SELECT 1 FROM activities a WHERE a.sales_cycle_id = c.id
            AND a.person_id = c.person_id AND a.callback_at = c.resurface_at)) THEN 'recorded_callback'
          WHEN EXISTS (SELECT 1 FROM sales_cycles c WHERE c.current_next_action_id = next_actions.id
            AND c.resurface_at IS NOT NULL) THEN 'founder_resurface' ELSE 'legacy_unscheduled' END`,
      `INSERT INTO next_actions (id, sales_cycle_id, action_type, channel, status, timezone, work_intent,
        due_at, due_source, created_at, updated_at)
        SELECT id || ':review', id, 'review_lead', NULL, 'pending', 'America/New_York', 'internal_review',
          COALESCE(resurface_at, created_at), 'internal_review', created_at, updated_at
        FROM sales_cycles WHERE stage = 'unreviewed' AND workflow_status = 'active' AND current_next_action_id IS NULL`,
      `UPDATE sales_cycles SET current_next_action_id = id || ':review'
        WHERE stage = 'unreviewed' AND workflow_status = 'active' AND current_next_action_id IS NULL`,
      `CREATE INDEX next_actions_due_idx ON next_actions(status, due_at)`,
      // Compatibility for raw intake/legacy fixture writers. Domain writers pass
      // scheduler dates explicitly. AFTER INSERT runs within the same transaction.
      `CREATE TRIGGER initialize_next_action_due AFTER INSERT ON next_actions WHEN NEW.due_at IS NULL
        BEGIN UPDATE next_actions SET due_at = NEW.created_at WHERE id = NEW.id; END`,
      `CREATE TRIGGER protect_next_action_due BEFORE UPDATE OF due_at, due_source ON next_actions
        WHEN NEW.due_at IS NULL OR (OLD.status <> 'pending' AND OLD.due_at IS NOT NULL
          AND (NEW.due_at IS NOT OLD.due_at OR NEW.due_source IS NOT OLD.due_source))
        BEGIN SELECT RAISE(ABORT, 'action due date required and settled schedule immutable'); END`,
      `CREATE TRIGGER initialize_unreviewed_action AFTER INSERT ON sales_cycles
        WHEN NEW.stage = 'unreviewed' AND NEW.workflow_status = 'active' AND NEW.current_next_action_id IS NULL
        BEGIN
          INSERT INTO next_actions (id, sales_cycle_id, action_type, status, timezone, work_intent,
            due_at, due_source, created_at, updated_at)
            VALUES (NEW.id || ':review', NEW.id, 'review_lead', 'pending', 'America/New_York', 'internal_review',
              COALESCE(NEW.resurface_at, NEW.created_at), 'internal_review', NEW.created_at, NEW.updated_at);
          UPDATE sales_cycles SET current_next_action_id = NEW.id || ':review' WHERE id = NEW.id;
        END`,
      `CREATE TRIGGER protect_operational_action_pointer BEFORE UPDATE OF current_next_action_id, workflow_status ON sales_cycles
        WHEN NEW.workflow_status IN ('active','onboarding') AND NEW.current_next_action_id IS NULL
        BEGIN SELECT RAISE(ABORT, 'operational cycle requires authoritative dated action'); END`,
      `UPDATE app_meta SET schema_version = 18 WHERE singleton = 1`,
    ];
    for (const statement of statements) await sql.raw(statement).execute(db);
  },
};
