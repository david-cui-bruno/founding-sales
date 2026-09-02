import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

/**
 * No-due-dates model (founder-confirmed 2026-09-02). Actions lose due
 * semantics app-wide:
 *
 * - `next_actions` drops `due_at` and `sla_due_at` (and the due index).
 *   Cadence steps stay ordered sequences with attempt caps; between-touch
 *   spacing is last-touch age plus the resurfacing window, never a stored
 *   due time. Inbound SLA columns survive because fresh-inbound ordering is
 *   one of the two places time-sensitivity legitimately remains.
 * - `sales_cycles` gains founder-chosen `resurface_at`/`resurface_reason`
 *   (snooze or promised callback), and relaxes the current-action CHECK so
 *   Unreviewed cycles carry NO next action: reviewing a lead is the
 *   inspector flow now, not generated work.
 * - Data repair: unreviewed cycles' current pointers are cleared and their
 *   pending 'review_lead' actions are dropped during the rebuild copy.
 * - `activities` gains `note_text` (founder-authored prose, local-only),
 *   `call_outcome`, and `callback_at` via append-only column adds; the
 *   column-scoped immutability trigger is recreated to freeze them.
 * - `review_position` is a new single-row table for triage resume.
 *
 * SQLite cannot alter CHECK constraints, so both tables are rebuilt in
 * place with the 0005 holding-table recipe: copy into a holding table,
 * drop, recreate under the same name, reinsert, and recreate every trigger
 * that lived on the rebuilt table. `PRAGMA defer_foreign_keys` keeps the
 * surrounding migration transaction satisfied until both rebuilt tables
 * exist and `PRAGMA foreign_key_check` proves the graph is whole.
 */
const noDueDatesStatements = [
  // ------------------------------------------------------- sales_cycles
  `CREATE TABLE sales_cycles_migration_holding AS
    SELECT id, person_id, prospect_id, entry_source_event_id, stage,
      workflow_status, current_next_action_id, stage_entered_at,
      design_partner_fitness, close_reason, close_notes,
      onboarding_stop_reason, closed_at, version, created_at, updated_at
    FROM sales_cycles`,
  `DROP TABLE sales_cycles`,
  `CREATE TABLE sales_cycles (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    prospect_id TEXT NOT NULL,
    entry_source_event_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN (
      'unreviewed','ready','contacted','interviewed','offered','won','lost_nurture'
    )),
    workflow_status TEXT NOT NULL CHECK (
      workflow_status IN ('active','onboarding','closed')
    ),
    current_next_action_id TEXT,
    stage_entered_at TEXT NOT NULL,
    design_partner_fitness INTEGER CHECK (design_partner_fitness BETWEEN 0 AND 5),
    close_reason TEXT CHECK (close_reason IN (
      'no_response','not_interested','bad_timing','not_decision_maker',
      'not_qualified','price','trust','chose_alternative','product_gap',
      'cadence_exhausted','disqualified','opt_out','other'
    )),
    close_notes TEXT,
    onboarding_stop_reason TEXT,
    closed_at TEXT,
    resurface_at TEXT,
    resurface_reason TEXT CHECK (resurface_reason IN ('snooze','callback')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (workflow_status IN ('active','onboarding')
        AND (current_next_action_id IS NOT NULL OR stage = 'unreviewed'))
      OR (workflow_status = 'closed' AND current_next_action_id IS NULL)
    ),
    CHECK (
      (resurface_at IS NULL AND resurface_reason IS NULL)
      OR (resurface_at IS NOT NULL AND resurface_reason IS NOT NULL)
    ),
    CHECK (
      (workflow_status = 'active' AND stage IN (
        'unreviewed','ready','contacted','interviewed','offered'
      ))
      OR (workflow_status = 'onboarding' AND stage = 'won')
      OR (workflow_status = 'closed' AND stage IN ('won','lost_nurture'))
    ),
    CHECK (
      (workflow_status IN ('active', 'onboarding') AND closed_at IS NULL)
      OR (workflow_status = 'closed' AND closed_at IS NOT NULL)
    ),
    CHECK (
      (stage = 'lost_nurture' AND close_reason IS NOT NULL)
      OR (stage <> 'lost_nurture' AND close_reason IS NULL AND close_notes IS NULL)
    ),
    CHECK (
      close_reason <> 'other'
      OR (close_notes IS NOT NULL AND length(trim(close_notes)) > 0)
    ),
    UNIQUE (id, person_id),
    FOREIGN KEY (prospect_id, person_id) REFERENCES prospects(id, person_id),
    FOREIGN KEY (entry_source_event_id, person_id) REFERENCES source_events(id, person_id),
    FOREIGN KEY (current_next_action_id, id)
      REFERENCES next_actions(id, sales_cycle_id) DEFERRABLE INITIALLY DEFERRED
  )`,
  // Unreviewed cycles stop carrying generated review work: the pointer is
  // cleared here and the pending review_lead rows are dropped below.
  `INSERT INTO sales_cycles (
    id, person_id, prospect_id, entry_source_event_id, stage,
    workflow_status, current_next_action_id, stage_entered_at,
    design_partner_fitness, close_reason, close_notes,
    onboarding_stop_reason, closed_at, resurface_at, resurface_reason,
    version, created_at, updated_at
  )
  SELECT id, person_id, prospect_id, entry_source_event_id, stage,
    workflow_status,
    CASE WHEN stage = 'unreviewed' AND workflow_status = 'active'
      THEN NULL ELSE current_next_action_id END,
    stage_entered_at, design_partner_fitness, close_reason, close_notes,
    onboarding_stop_reason, closed_at, NULL, NULL,
    version, created_at, updated_at
  FROM sales_cycles_migration_holding`,
  `DROP TABLE sales_cycles_migration_holding`,
  `CREATE UNIQUE INDEX one_open_cycle_per_person
    ON sales_cycles(person_id)
    WHERE workflow_status IN ('active','onboarding')`,
  `CREATE TRIGGER protect_cycle_pointer_insert
    BEFORE INSERT ON sales_cycles
    WHEN NEW.current_next_action_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM next_actions
        WHERE id = NEW.current_next_action_id
          AND sales_cycle_id = NEW.id
          AND status <> 'pending'
      )
    BEGIN
      SELECT RAISE(ABORT, 'current next action must be pending');
    END`,
  `CREATE TRIGGER protect_cycle_pointer_update
    BEFORE UPDATE OF current_next_action_id ON sales_cycles
    WHEN NEW.current_next_action_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM next_actions
        WHERE id = NEW.current_next_action_id
          AND sales_cycle_id = NEW.id
          AND status = 'pending'
      )
    BEGIN
      SELECT RAISE(ABORT, 'replacement current next action must exist and be pending');
    END`,
  `CREATE TRIGGER protect_cycle_entry_source
    BEFORE UPDATE OF entry_source_event_id ON sales_cycles
    WHEN NEW.entry_source_event_id IS NOT OLD.entry_source_event_id
    BEGIN
      SELECT RAISE(ABORT, 'sales-cycle entry source is immutable');
    END`,
  `CREATE TRIGGER protect_design_partner_fitness
    BEFORE INSERT ON sales_cycles
    WHEN NEW.design_partner_fitness IS NOT NULL
      AND NEW.stage NOT IN ('interviewed','offered','won')
      AND NOT EXISTS (
        SELECT 1 FROM stage_events
        WHERE sales_cycle_id = NEW.id
          AND to_stage IN ('interviewed','offered','won')
      )
    BEGIN
      SELECT RAISE(ABORT, 'design partner fitness requires interviewed history');
    END`,
  `CREATE TRIGGER protect_design_partner_fitness_update
    BEFORE UPDATE OF design_partner_fitness ON sales_cycles
    WHEN NEW.design_partner_fitness IS NOT NULL
      AND NEW.stage NOT IN ('interviewed','offered','won')
      AND NOT EXISTS (
        SELECT 1 FROM stage_events
        WHERE sales_cycle_id = NEW.id
          AND to_stage IN ('interviewed','offered','won')
      )
    BEGIN
      SELECT RAISE(ABORT, 'design partner fitness requires interviewed history');
    END`,
  `CREATE TRIGGER protect_opted_out_operational_cycle_insert
    BEFORE INSERT ON sales_cycles
    WHEN NEW.workflow_status IN ('active','onboarding')
      AND EXISTS (
        SELECT 1 FROM persons AS person
        WHERE person.id = NEW.person_id
          AND (
            person.opted_out = 1
            OR EXISTS (
              SELECT 1 FROM opt_out_tombstones AS tombstone
              WHERE tombstone.person_id = NEW.person_id
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'opted-out person cannot own operational lifecycle work');
    END`,
  `CREATE TRIGGER protect_opted_out_operational_cycle_update
    BEFORE UPDATE OF person_id, workflow_status ON sales_cycles
    WHEN NEW.workflow_status IN ('active','onboarding')
      AND EXISTS (
        SELECT 1 FROM persons AS person
        WHERE person.id = NEW.person_id
          AND (
            person.opted_out = 1
            OR EXISTS (
              SELECT 1 FROM opt_out_tombstones AS tombstone
              WHERE tombstone.person_id = NEW.person_id
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'opted-out person cannot own operational lifecycle work');
    END`,
  // -------------------------------------------------------- next_actions
  `CREATE TABLE next_actions_migration_holding AS
    SELECT id, sales_cycle_id, action_type, channel, status, timezone,
      allowed_window, work_intent, inbound_sla_kind, inbound_sla_due_at,
      inbound_sla_source_event_id, inbound_sla_provenance_json,
      cadence_enrollment_id, cadence_step_id, cadence_component_id,
      completion_activity_id, settlement_json, version, created_at,
      completed_at, updated_at
    FROM next_actions
    WHERE NOT (
      action_type = 'review_lead'
      AND status = 'pending'
      AND EXISTS (
        SELECT 1 FROM sales_cycles AS cycle
        WHERE cycle.id = next_actions.sales_cycle_id
          AND cycle.stage = 'unreviewed'
      )
    )`,
  `DROP TABLE next_actions`,
  `CREATE TABLE next_actions (
    id TEXT PRIMARY KEY,
    sales_cycle_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    channel TEXT,
    status TEXT NOT NULL CHECK (
      status IN ('pending','completed','cancelled','impossible')
    ),
    timezone TEXT NOT NULL,
    allowed_window TEXT,
    work_intent TEXT NOT NULL DEFAULT 'promised_follow_up' CHECK (
      work_intent IN (
        'internal_review','inbound_response','promised_follow_up',
        'discretionary_prospecting'
      )
    ),
    inbound_sla_kind TEXT CHECK (inbound_sla_kind IN (
      'inbound_demo_permitted_minutes','direct_referral_elapsed'
    )),
    inbound_sla_due_at TEXT,
    inbound_sla_source_event_id TEXT,
    inbound_sla_provenance_json TEXT,
    cadence_enrollment_id TEXT REFERENCES cadence_enrollments(id),
    cadence_step_id TEXT REFERENCES cadence_steps(id),
    cadence_component_id TEXT REFERENCES cadence_action_components(id),
    completion_activity_id TEXT,
    settlement_json TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
    UNIQUE (id, sales_cycle_id),
    FOREIGN KEY (sales_cycle_id)
      REFERENCES sales_cycles(id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (completion_activity_id, sales_cycle_id)
      REFERENCES activities(id, sales_cycle_id),
    FOREIGN KEY (cadence_enrollment_id, sales_cycle_id)
      REFERENCES cadence_enrollments(id, sales_cycle_id),
    FOREIGN KEY (cadence_component_id, cadence_step_id)
      REFERENCES cadence_action_components(id, cadence_step_id),
    FOREIGN KEY (inbound_sla_source_event_id)
      REFERENCES source_events(id),
    CHECK (
      (status = 'pending' AND completed_at IS NULL
        AND completion_activity_id IS NULL AND settlement_json IS NULL)
      OR (status <> 'pending' AND completed_at IS NOT NULL
        AND settlement_json IS NOT NULL)
    ),
    CHECK (
      (
        cadence_enrollment_id IS NULL
        AND cadence_step_id IS NULL
        AND cadence_component_id IS NULL
      )
      OR (
        cadence_enrollment_id IS NOT NULL
        AND cadence_step_id IS NOT NULL
        AND cadence_component_id IS NOT NULL
      )
    ),
    CHECK (
      (
        inbound_sla_kind IS NULL
        AND inbound_sla_due_at IS NULL
        AND inbound_sla_source_event_id IS NULL
        AND inbound_sla_provenance_json IS NULL
      )
      OR (
        work_intent = 'inbound_response'
        AND inbound_sla_kind IS NOT NULL
        AND inbound_sla_due_at IS NOT NULL
        AND inbound_sla_source_event_id IS NOT NULL
        AND inbound_sla_provenance_json IS NOT NULL
      )
    )
  )`,
  `INSERT INTO next_actions (
    id, sales_cycle_id, action_type, channel, status, timezone,
    allowed_window, work_intent, inbound_sla_kind, inbound_sla_due_at,
    inbound_sla_source_event_id, inbound_sla_provenance_json,
    cadence_enrollment_id, cadence_step_id, cadence_component_id,
    completion_activity_id, settlement_json, version, created_at,
    completed_at, updated_at
  )
  SELECT id, sales_cycle_id, action_type, channel, status, timezone,
    allowed_window, work_intent, inbound_sla_kind, inbound_sla_due_at,
    inbound_sla_source_event_id, inbound_sla_provenance_json,
    cadence_enrollment_id, cadence_step_id, cadence_component_id,
    completion_activity_id, settlement_json, version, created_at,
    completed_at, updated_at
  FROM next_actions_migration_holding`,
  `DROP TABLE next_actions_migration_holding`,
  `CREATE TRIGGER protect_current_action_status
    BEFORE UPDATE OF status ON next_actions
    WHEN NEW.status <> 'pending'
      AND EXISTS (
        SELECT 1 FROM sales_cycles
        WHERE id = OLD.sales_cycle_id AND current_next_action_id = OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'current next action must remain pending until pointer movement');
    END`,
  `CREATE TRIGGER protect_current_action_delete
    BEFORE DELETE ON next_actions
    WHEN EXISTS (
      SELECT 1 FROM sales_cycles
      WHERE id = OLD.sales_cycle_id AND current_next_action_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'current next action cannot be deleted before pointer movement');
    END`,
  `CREATE TRIGGER protect_initial_action_status
    BEFORE INSERT ON next_actions
    WHEN NEW.status <> 'pending'
      AND EXISTS (
        SELECT 1 FROM sales_cycles
        WHERE id = NEW.sales_cycle_id AND current_next_action_id = NEW.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'current next action must be inserted pending');
    END`,
  `CREATE TRIGGER protect_next_action_cadence_insert
    BEFORE INSERT ON next_actions
    WHEN NEW.cadence_enrollment_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM cadence_enrollments AS enrollment
        JOIN cadence_steps AS step
          ON step.id = NEW.cadence_step_id
         AND step.cadence_definition_id = enrollment.cadence_definition_id
        JOIN cadence_action_components AS component
          ON component.id = NEW.cadence_component_id
         AND component.cadence_step_id = step.id
        WHERE enrollment.id = NEW.cadence_enrollment_id
          AND enrollment.sales_cycle_id = NEW.sales_cycle_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'next action cadence references must share one owner graph');
    END`,
  `CREATE TRIGGER protect_next_action_cadence_update
    BEFORE UPDATE OF sales_cycle_id, cadence_enrollment_id, cadence_step_id,
      cadence_component_id ON next_actions
    WHEN NEW.cadence_enrollment_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM cadence_enrollments AS enrollment
        JOIN cadence_steps AS step
          ON step.id = NEW.cadence_step_id
         AND step.cadence_definition_id = enrollment.cadence_definition_id
        JOIN cadence_action_components AS component
          ON component.id = NEW.cadence_component_id
         AND component.cadence_step_id = step.id
        WHERE enrollment.id = NEW.cadence_enrollment_id
          AND enrollment.sales_cycle_id = NEW.sales_cycle_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'next action cadence references must share one owner graph');
    END`,
  `CREATE TRIGGER protect_next_action_inbound_sla_insert
    BEFORE INSERT ON next_actions
    WHEN NEW.inbound_sla_source_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sales_cycles AS cycle
        JOIN source_events AS source
          ON source.id = NEW.inbound_sla_source_event_id
         AND source.person_id = cycle.person_id
        WHERE cycle.id = NEW.sales_cycle_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'inbound SLA evidence must belong to the cycle person');
    END`,
  `CREATE TRIGGER protect_next_action_inbound_sla_update
    BEFORE UPDATE OF sales_cycle_id, inbound_sla_source_event_id ON next_actions
    WHEN NEW.inbound_sla_source_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sales_cycles AS cycle
        JOIN source_events AS source
          ON source.id = NEW.inbound_sla_source_event_id
         AND source.person_id = cycle.person_id
        WHERE cycle.id = NEW.sales_cycle_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'inbound SLA evidence must belong to the cycle person');
    END`,
  `CREATE TRIGGER protect_next_action_immutable_evidence
    BEFORE UPDATE OF sales_cycle_id, action_type, channel, work_intent, inbound_sla_kind,
      inbound_sla_due_at, inbound_sla_source_event_id,
      inbound_sla_provenance_json, cadence_enrollment_id, cadence_step_id,
      cadence_component_id, settlement_json ON next_actions
    WHEN NEW.sales_cycle_id IS NOT OLD.sales_cycle_id
      OR NEW.action_type IS NOT OLD.action_type
      OR NEW.channel IS NOT OLD.channel
      OR NEW.work_intent IS NOT OLD.work_intent
      OR NEW.inbound_sla_kind IS NOT OLD.inbound_sla_kind
      OR NEW.inbound_sla_due_at IS NOT OLD.inbound_sla_due_at
      OR NEW.inbound_sla_source_event_id IS NOT OLD.inbound_sla_source_event_id
      OR NEW.inbound_sla_provenance_json IS NOT OLD.inbound_sla_provenance_json
      OR NEW.cadence_enrollment_id IS NOT OLD.cadence_enrollment_id
      OR NEW.cadence_step_id IS NOT OLD.cadence_step_id
      OR NEW.cadence_component_id IS NOT OLD.cadence_component_id
      OR (OLD.settlement_json IS NOT NULL AND NEW.settlement_json IS NOT OLD.settlement_json)
    BEGIN
      SELECT RAISE(ABORT, 'next action ownership and evidence are immutable');
    END`,
  `CREATE TRIGGER protect_next_action_settlement
    BEFORE UPDATE OF status, completion_activity_id, settlement_json, completed_at
      ON next_actions
    WHEN OLD.status <> 'pending'
      OR NEW.status = 'pending'
      OR NEW.completed_at IS NULL
      OR NEW.settlement_json IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'next action settlement is one-way and immutable');
    END`,
  `CREATE TRIGGER protect_settled_next_action_schedule
    BEFORE UPDATE OF timezone, allowed_window, created_at
      ON next_actions
    WHEN (OLD.status <> 'pending' OR NEW.status <> 'pending')
      AND (
        NEW.timezone IS NOT OLD.timezone
        OR NEW.allowed_window IS NOT OLD.allowed_window
        OR NEW.created_at IS NOT OLD.created_at
      )
    BEGIN
      SELECT RAISE(ABORT, 'settled next action scheduling evidence is immutable');
    END`,
  `CREATE TRIGGER protect_next_action_delete
    BEFORE DELETE ON next_actions
    BEGIN
      SELECT RAISE(ABORT, 'next actions are retained permanently');
    END`,
  `CREATE TRIGGER protect_opted_out_next_action_insert
    BEFORE INSERT ON next_actions
    WHEN NEW.status = 'pending' AND NEW.channel IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM sales_cycles AS cycle
        JOIN persons AS person ON person.id = cycle.person_id
        WHERE cycle.id = NEW.sales_cycle_id
          AND (
            person.opted_out = 1
            OR EXISTS (
              SELECT 1 FROM opt_out_tombstones AS tombstone
              WHERE tombstone.person_id = cycle.person_id
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'opted-out person cannot receive pending outbound work');
    END`,
  `CREATE TRIGGER protect_opted_out_next_action_update
    BEFORE UPDATE OF sales_cycle_id, status, channel ON next_actions
    WHEN NEW.status = 'pending' AND NEW.channel IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM sales_cycles AS cycle
        JOIN persons AS person ON person.id = cycle.person_id
        WHERE cycle.id = NEW.sales_cycle_id
          AND (
            person.opted_out = 1
            OR EXISTS (
              SELECT 1 FROM opt_out_tombstones AS tombstone
              WHERE tombstone.person_id = cycle.person_id
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'opted-out person cannot receive pending outbound work');
    END`,
  // ---------------------------------------------------------- activities
  // Append-only column adds: founder note prose (the ONE place prose is
  // allowed, local-only), call outcome, and the optional promised callback.
  `ALTER TABLE activities ADD COLUMN note_text TEXT`,
  `ALTER TABLE activities ADD COLUMN call_outcome TEXT CHECK (call_outcome IN (
    'no_answer','voicemail','spoke','interview_booked','not_interested','opted_out'
  ))`,
  `ALTER TABLE activities ADD COLUMN callback_at TEXT`,
  `DROP TRIGGER immutable_activities`,
  `CREATE TRIGGER immutable_activities
    BEFORE UPDATE ON activities
    WHEN NEW.id IS NOT OLD.id
      OR NEW.person_id IS NOT OLD.person_id
      OR NEW.prospect_id IS NOT OLD.prospect_id
      OR NEW.sales_cycle_id IS NOT OLD.sales_cycle_id
      OR NEW.cadence_enrollment_id IS NOT OLD.cadence_enrollment_id
      OR NEW.cadence_step_id IS NOT OLD.cadence_step_id
      OR NEW.cadence_component_id IS NOT OLD.cadence_component_id
      OR NEW.kind IS NOT OLD.kind
      OR NEW.direction IS NOT OLD.direction
      OR NEW.channel IS NOT OLD.channel
      OR NEW.occurred_at IS NOT OLD.occurred_at
      OR NEW.duration_seconds IS NOT OLD.duration_seconds
      OR NEW.observed_outcome IS NOT OLD.observed_outcome
      OR NEW.adapter IS NOT OLD.adapter
      OR NEW.provider_idempotency_key IS NOT OLD.provider_idempotency_key
      OR NEW.provider_reference IS NOT OLD.provider_reference
      OR NEW.recording_storage_ref IS NOT OLD.recording_storage_ref
      OR NEW.metadata_json IS NOT OLD.metadata_json
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.note_text IS NOT OLD.note_text
      OR NEW.call_outcome IS NOT OLD.call_outcome
      OR NEW.callback_at IS NOT OLD.callback_at
    BEGIN
      SELECT RAISE(ABORT, 'activities rows are immutable');
    END`,
  // ------------------------------------------------------ review_position
  `CREATE TABLE review_position (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    position INTEGER NOT NULL CHECK (position >= 0),
    updated_at TEXT NOT NULL
  )`,
] as const;

export const migration0010NoDueDates = {
  async up(db: Kysely<FoundationDatabase>) {
    // The migration runner holds one BEGIN IMMEDIATE transaction around
    // every pending migration. Deferring foreign keys is scoped to that
    // transaction and resets itself at commit.
    await sql.raw('PRAGMA defer_foreign_keys = ON').execute(db);

    for (const statement of noDueDatesStatements) {
      await sql.raw(statement).execute(db);
    }

    const violations = await sql.raw('PRAGMA foreign_key_check').execute(db);
    if (violations.rows.length > 0) {
      throw new Error(
        'The no-due-dates table rebuild left dangling foreign keys.',
      );
    }

    const timestamp = new Date().toISOString();
    await sql`
      INSERT INTO review_position (singleton, position, updated_at)
      VALUES (1, 0, ${timestamp})
    `.execute(db);
    await sql`
      UPDATE app_meta
      SET schema_version = 10, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};
