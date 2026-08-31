import { sql, type Kysely } from 'kysely';

import type { FoundationDatabase } from '../schema';

const domainStatements = [
  `ALTER TABLE jobs ADD COLUMN idempotency_key TEXT`,
  `CREATE UNIQUE INDEX jobs_type_idempotency_idx
    ON jobs(type, idempotency_key)
    WHERE idempotency_key IS NOT NULL`,
  `CREATE TABLE persons (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    opted_out INTEGER NOT NULL DEFAULT 0 CHECK (opted_out IN (0, 1)),
    opted_out_at TEXT,
    never_record INTEGER NOT NULL DEFAULT 0 CHECK (never_record IN (0, 1)),
    deleted_at TEXT,
    provenance_json TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (opted_out = 0 AND opted_out_at IS NULL)
      OR (opted_out = 1 AND opted_out_at IS NOT NULL)
    )
  )`,
  `CREATE TABLE person_contact_methods (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    kind TEXT NOT NULL CHECK (kind IN ('phone', 'email')),
    normalized_value TEXT NOT NULL CHECK (length(normalized_value) > 0),
    raw_value TEXT,
    validation_state TEXT NOT NULL CHECK (
      validation_state IN ('unverified', 'valid', 'invalid')
    ),
    reachability TEXT NOT NULL CHECK (
      reachability IN ('direct', 'indirect', 'none')
    ),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    in_contacts INTEGER CHECK (in_contacts IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (person_id, kind, normalized_value)
  )`,
  `CREATE INDEX person_contact_methods_lookup_idx
    ON person_contact_methods(kind, normalized_value)`,
  `CREATE UNIQUE INDEX one_primary_contact_per_kind
    ON person_contact_methods(person_id, kind)
    WHERE is_primary = 1`,
  `CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL CHECK (length(trim(canonical_name)) > 0),
    source_record_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE organization_aliases (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    alias TEXT NOT NULL CHECK (length(trim(alias)) > 0),
    created_at TEXT NOT NULL,
    UNIQUE (organization_id, alias)
  )`,
  `CREATE TABLE properties (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id),
    address_line_1 TEXT NOT NULL,
    address_line_2 TEXT,
    locality TEXT NOT NULL,
    region TEXT NOT NULL,
    postal_code TEXT,
    country_code TEXT NOT NULL DEFAULT 'US',
    door_count INTEGER CHECK (door_count >= 0),
    property_type TEXT,
    maintenance_profile_json TEXT,
    source_record_json TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE source_events (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    prospect_id TEXT,
    sales_cycle_id TEXT,
    channel TEXT NOT NULL CHECK (channel IN (
      'frbo', 'registry', 'rireig', 'referral',
      'inbound_demo', 'community', 'custom'
    )),
    observed_at TEXT NOT NULL,
    source_record_json TEXT NOT NULL,
    evidence_ref TEXT,
    referred_by_person_id TEXT REFERENCES persons(id),
    referrer_unknown_reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (id, person_id),
    FOREIGN KEY (prospect_id, person_id) REFERENCES prospects(id, person_id),
    FOREIGN KEY (sales_cycle_id, person_id) REFERENCES sales_cycles(id, person_id),
    CHECK (referred_by_person_id IS NULL OR referred_by_person_id <> person_id),
    CHECK (
      (
        channel = 'referral'
        AND (
          (
            referred_by_person_id IS NOT NULL
            AND referrer_unknown_reason IS NULL
          )
          OR (
            referred_by_person_id IS NULL
            AND referrer_unknown_reason IS NOT NULL
            AND length(trim(referrer_unknown_reason)) > 0
          )
        )
      )
      OR (
        channel <> 'referral'
        AND referred_by_person_id IS NULL
        AND referrer_unknown_reason IS NULL
      )
    )
  )`,
  `CREATE INDEX source_events_person_observed_idx
    ON source_events(person_id, observed_at)`,
  `CREATE TABLE source_intake_receipts (
    source_event_id TEXT PRIMARY KEY REFERENCES source_events(id),
    person_id TEXT NOT NULL,
    prospect_id TEXT NOT NULL,
    command_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (source_event_id, person_id)
      REFERENCES source_events(id, person_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (prospect_id, person_id)
      REFERENCES prospects(id, person_id) DEFERRABLE INITIALLY DEFERRED
  )`,
  `CREATE TABLE prospects (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    original_source_event_id TEXT NOT NULL,
    segment TEXT NOT NULL CHECK (segment IN ('hot_frbo', 'cold_registry', 'warm')),
    qualification_state TEXT NOT NULL CHECK (
      qualification_state IN ('unreviewed', 'eligible', 'disqualified', 'merge_review')
    ),
    qualification_reason TEXT,
    last_contact_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (person_id),
    UNIQUE (id, person_id),
    FOREIGN KEY (original_source_event_id, person_id)
      REFERENCES source_events(id, person_id)
  )`,
  `CREATE TABLE prospect_organizations (
    prospect_id TEXT NOT NULL REFERENCES prospects(id),
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    relationship TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (prospect_id, organization_id)
  )`,
  `CREATE TABLE prospect_properties (
    prospect_id TEXT NOT NULL REFERENCES prospects(id),
    property_id TEXT NOT NULL REFERENCES properties(id),
    relationship TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (prospect_id, property_id)
  )`,
  `CREATE TABLE cadence_definitions (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    attempt_cap INTEGER NOT NULL CHECK (attempt_cap > 0),
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (family, version),
    UNIQUE (content_hash)
  )`,
  `CREATE TABLE cadence_steps (
    id TEXT PRIMARY KEY,
    cadence_definition_id TEXT NOT NULL REFERENCES cadence_definitions(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    day_offset INTEGER NOT NULL CHECK (day_offset >= 0),
    label TEXT NOT NULL,
    breakup INTEGER NOT NULL DEFAULT 0 CHECK (breakup IN (0, 1)),
    step_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (cadence_definition_id, sequence),
    UNIQUE (id, cadence_definition_id)
  )`,
  `CREATE TABLE cadence_action_components (
    id TEXT PRIMARY KEY,
    cadence_step_id TEXT NOT NULL REFERENCES cadence_steps(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    action_type TEXT NOT NULL,
    channel TEXT,
    condition_json TEXT,
    outcome_graph_json TEXT NOT NULL,
    template_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (cadence_step_id, sequence),
    UNIQUE (id, cadence_step_id)
  )`,
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
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (workflow_status IN ('active','onboarding') AND current_next_action_id IS NOT NULL)
      OR (workflow_status = 'closed' AND current_next_action_id IS NULL)
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
  `CREATE UNIQUE INDEX one_open_cycle_per_person
    ON sales_cycles(person_id)
    WHERE workflow_status IN ('active','onboarding')`,
  `CREATE TABLE next_actions (
    id TEXT PRIMARY KEY,
    sales_cycle_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    channel TEXT,
    status TEXT NOT NULL CHECK (
      status IN ('pending','completed','cancelled','impossible')
    ),
    due_at TEXT NOT NULL,
    timezone TEXT NOT NULL,
    allowed_window TEXT,
    work_intent TEXT NOT NULL DEFAULT 'promised_follow_up' CHECK (
      work_intent IN (
        'internal_review','inbound_response','promised_follow_up',
        'discretionary_prospecting'
      )
    ),
    sla_due_at TEXT,
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
  `CREATE INDEX next_actions_due_idx ON next_actions(status, due_at)`,
  `CREATE TABLE cadence_enrollments (
    id TEXT PRIMARY KEY,
    sales_cycle_id TEXT NOT NULL REFERENCES sales_cycles(id),
    cadence_definition_id TEXT NOT NULL REFERENCES cadence_definitions(id),
    status TEXT NOT NULL CHECK (status IN ('active','completed','stopped')),
    anchor_at TEXT NOT NULL,
    current_step_id TEXT REFERENCES cadence_steps(id),
    scheduled_step_count INTEGER NOT NULL DEFAULT 0 CHECK (scheduled_step_count >= 0),
    mode TEXT NOT NULL DEFAULT 'standard' CHECK (
      mode IN ('standard','inbound_over_cap_response')
    ),
    allowed_step_ids_json TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    stop_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, sales_cycle_id),
    FOREIGN KEY (current_step_id, cadence_definition_id)
      REFERENCES cadence_steps(id, cadence_definition_id),
    CHECK (
      (status = 'active' AND stop_reason IS NULL)
      OR status <> 'active'
    )
  )`,
  `CREATE UNIQUE INDEX one_active_cadence_per_cycle
    ON cadence_enrollments(sales_cycle_id)
    WHERE status = 'active'`,
  `CREATE TABLE consent_policy_records (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    activity_id TEXT,
    policy_kind TEXT NOT NULL CHECK (
      policy_kind IN ('recording','cloud_processing','outbound')
    ),
    policy_version TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (
      decision IN ('granted','denied','not_required','unknown')
    ),
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, person_id),
    FOREIGN KEY (activity_id, person_id)
      REFERENCES activities(id, person_id) DEFERRABLE INITIALLY DEFERRED
  )`,
  `CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    prospect_id TEXT,
    sales_cycle_id TEXT,
    cadence_enrollment_id TEXT,
    cadence_step_id TEXT REFERENCES cadence_steps(id),
    cadence_component_id TEXT,
    kind TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','internal')),
    channel TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    duration_seconds INTEGER CHECK (duration_seconds >= 0),
    observed_outcome TEXT,
    adapter TEXT,
    provider_idempotency_key TEXT,
    provider_reference TEXT,
    consent_policy_record_id TEXT,
    recording_storage_ref TEXT,
    transcript_storage_ref TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, person_id),
    UNIQUE (id, sales_cycle_id),
    FOREIGN KEY (prospect_id, person_id) REFERENCES prospects(id, person_id),
    FOREIGN KEY (sales_cycle_id, person_id) REFERENCES sales_cycles(id, person_id),
    FOREIGN KEY (cadence_enrollment_id, sales_cycle_id)
      REFERENCES cadence_enrollments(id, sales_cycle_id),
    FOREIGN KEY (consent_policy_record_id, person_id)
      REFERENCES consent_policy_records(id, person_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (cadence_component_id, cadence_step_id)
      REFERENCES cadence_action_components(id, cadence_step_id),
    CHECK (provider_idempotency_key IS NULL OR adapter IS NOT NULL),
    CHECK (
      (recording_storage_ref IS NULL AND transcript_storage_ref IS NULL)
      OR consent_policy_record_id IS NOT NULL
    ),
    CHECK (
      (
        cadence_enrollment_id IS NULL
        AND cadence_step_id IS NULL
        AND cadence_component_id IS NULL
      )
      OR (
        sales_cycle_id IS NOT NULL
        AND cadence_enrollment_id IS NOT NULL
        AND cadence_step_id IS NOT NULL
        AND cadence_component_id IS NOT NULL
      )
    )
  )`,
  `CREATE UNIQUE INDEX activities_provider_idempotency_idx
    ON activities(adapter, provider_idempotency_key)
    WHERE adapter IS NOT NULL AND provider_idempotency_key IS NOT NULL`,
  `CREATE INDEX activities_person_occurred_idx
    ON activities(person_id, occurred_at)`,
  `CREATE TABLE activity_amendments (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities(id),
    amendment_kind TEXT NOT NULL,
    correction_json TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE stage_events (
    id TEXT PRIMARY KEY,
    sales_cycle_id TEXT NOT NULL REFERENCES sales_cycles(id),
    from_stage TEXT CHECK (from_stage IN (
      'unreviewed','ready','contacted','interviewed','offered','won','lost_nurture'
    )),
    to_stage TEXT NOT NULL CHECK (to_stage IN (
      'unreviewed','ready','contacted','interviewed','offered','won','lost_nurture'
    )),
    effective_at TEXT NOT NULL,
    confirmed_at TEXT NOT NULL,
    confirmation_kind TEXT NOT NULL CHECK (
      confirmation_kind IN ('mechanical','founder','backfill')
    ),
    transition_sequence INTEGER NOT NULL CHECK (transition_sequence > 0),
    backfill_provenance_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (sales_cycle_id, transition_sequence),
    CHECK (
      (confirmation_kind = 'backfill' AND backfill_provenance_json IS NOT NULL)
      OR (confirmation_kind <> 'backfill' AND backfill_provenance_json IS NULL)
    )
  )`,
  `CREATE INDEX stage_events_cycle_effective_idx
    ON stage_events(sales_cycle_id, effective_at)`,
  `CREATE TABLE reactivation_rules (
    id TEXT PRIMARY KEY,
    sales_cycle_id TEXT NOT NULL REFERENCES sales_cycles(id),
    rule_type TEXT NOT NULL CHECK (rule_type IN (
      'seasonal:heating-oct1','new-frbo-listing',
      'lead-cert-expiry-window','manual'
    )),
    due_at TEXT,
    matcher_json TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (id, sales_cycle_id),
    CHECK (rule_type <> 'manual' OR due_at IS NOT NULL)
  )`,
  `CREATE TABLE cycle_reactivation_receipts (
    activation_key TEXT PRIMARY KEY CHECK (
      activation_key LIKE 'rule:%' OR activation_key LIKE 'inbound:%'
    ),
    activation_kind TEXT NOT NULL CHECK (
      activation_kind IN ('rule','inbound_response')
    ),
    person_id TEXT NOT NULL REFERENCES persons(id),
    source_cycle_id TEXT NOT NULL,
    reactivation_rule_id TEXT UNIQUE,
    source_event_id TEXT UNIQUE,
    new_cycle_id TEXT NOT NULL UNIQUE,
    command_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (source_cycle_id, person_id)
      REFERENCES sales_cycles(id, person_id),
    FOREIGN KEY (reactivation_rule_id, source_cycle_id)
      REFERENCES reactivation_rules(id, sales_cycle_id),
    FOREIGN KEY (source_event_id, person_id)
      REFERENCES source_events(id, person_id),
    FOREIGN KEY (new_cycle_id, person_id)
      REFERENCES sales_cycles(id, person_id) DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (
        activation_kind = 'rule'
        AND activation_key = 'rule:' || reactivation_rule_id
        AND reactivation_rule_id IS NOT NULL
        AND source_event_id IS NULL
      )
      OR (
        activation_kind = 'inbound_response'
        AND activation_key = 'inbound:' || source_event_id
        AND reactivation_rule_id IS NULL
        AND source_event_id IS NOT NULL
      )
    )
  )`,
  `CREATE TABLE lifecycle_review_items (
    id TEXT PRIMARY KEY,
    activation_key TEXT NOT NULL UNIQUE CHECK (length(trim(activation_key)) > 0),
    status TEXT NOT NULL CHECK (status IN ('open','resolved')),
    person_id TEXT NOT NULL REFERENCES persons(id),
    prospect_id TEXT NOT NULL,
    source_cycle_id TEXT NOT NULL,
    reactivation_rule_id TEXT,
    source_event_id TEXT,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    payload_json TEXT NOT NULL,
    resolution_json TEXT,
    resolved_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (prospect_id, person_id) REFERENCES prospects(id, person_id),
    FOREIGN KEY (source_cycle_id, person_id) REFERENCES sales_cycles(id, person_id),
    FOREIGN KEY (reactivation_rule_id, source_cycle_id)
      REFERENCES reactivation_rules(id, sales_cycle_id),
    FOREIGN KEY (source_event_id, person_id) REFERENCES source_events(id, person_id),
    CHECK (
      (status = 'open' AND resolution_json IS NULL AND resolved_at IS NULL)
      OR (status = 'resolved' AND resolution_json IS NOT NULL AND resolved_at IS NOT NULL)
    ),
    CHECK (
      (
        activation_key = 'rule:' || reactivation_rule_id
        AND reactivation_rule_id IS NOT NULL
        AND source_event_id IS NULL
      )
      OR (
        activation_key = 'inbound:' || source_event_id
        AND reactivation_rule_id IS NULL
        AND source_event_id IS NOT NULL
      )
    )
  )`,
  `CREATE TABLE won_terms (
    sales_cycle_id TEXT PRIMARY KEY REFERENCES sales_cycles(id),
    doors_committed INTEGER NOT NULL CHECK (doors_committed >= 0),
    billing_model TEXT NOT NULL CHECK (billing_model IN (
      'per_door_monthly','flat_monthly','manual_projected_monthly'
    )),
    unit_rate_cents INTEGER NOT NULL CHECK (unit_rate_cents >= 0),
    projected_mrr_cents INTEGER NOT NULL CHECK (projected_mrr_cents >= 0),
    projection_formula_version TEXT NOT NULL,
    manual_projection_reason TEXT,
    founding_customer INTEGER NOT NULL CHECK (founding_customer IN (0, 1)),
    effective_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
      (billing_model = 'per_door_monthly'
        AND projected_mrr_cents = doors_committed * unit_rate_cents
        AND manual_projection_reason IS NULL)
      OR (billing_model = 'flat_monthly'
        AND projected_mrr_cents = unit_rate_cents
        AND manual_projection_reason IS NULL)
      OR (billing_model = 'manual_projected_monthly'
        AND manual_projection_reason IS NOT NULL
        AND length(trim(manual_projection_reason)) > 0)
    )
  )`,
  `CREATE TABLE sales_cycle_close_readiness (
    sales_cycle_id TEXT PRIMARY KEY REFERENCES sales_cycles(id),
    pain_confirmed INTEGER NOT NULL CHECK (pain_confirmed IN (0, 1)),
    decision_authority_confirmed INTEGER NOT NULL CHECK (
      decision_authority_confirmed IN (0, 1)
    ),
    concrete_trial_identified INTEGER NOT NULL CHECK (
      concrete_trial_identified IN (0, 1)
    ),
    readiness_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    assessed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE trigger_events (
    id TEXT PRIMARY KEY,
    prospect_id TEXT NOT NULL REFERENCES prospects(id),
    source_event_id TEXT NOT NULL REFERENCES source_events(id),
    trigger_type TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    expires_at TEXT,
    strength_multiplier REAL NOT NULL CHECK (
      strength_multiplier >= 0 AND strength_multiplier <= 2
    ),
    verification_state TEXT NOT NULL CHECK (
      verification_state IN ('verified','unverified')
    ),
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (source_event_id)
  )`,
  `CREATE INDEX trigger_events_prospect_effective_idx
    ON trigger_events(prospect_id, effective_at)`,
  `CREATE TABLE prioritization_rule_versions (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version > 0),
    content_hash TEXT NOT NULL UNIQUE,
    rules_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE prioritization_evaluations (
    id TEXT PRIMARY KEY,
    prospect_id TEXT NOT NULL REFERENCES prospects(id),
    rule_version_id TEXT NOT NULL REFERENCES prioritization_rule_versions(id),
    evaluated_at TEXT NOT NULL,
    fit_points INTEGER NOT NULL CHECK (fit_points BETWEEN 0 AND 30),
    fit_band TEXT NOT NULL CHECK (fit_band IN ('low','medium','high')),
    timing_millipoints INTEGER NOT NULL CHECK (timing_millipoints BETWEEN 0 AND 40000),
    timing_band TEXT NOT NULL CHECK (timing_band IN ('cold','warm','hot')),
    reachability TEXT NOT NULL CHECK (reachability IN ('direct','indirect','none')),
    data_confidence INTEGER NOT NULL CHECK (data_confidence BETWEEN 0 AND 10),
    priority TEXT NOT NULL CHECK (priority IN ('p0','p1','p2','p3')),
    earliest_trigger_expires_at TEXT,
    verify_first INTEGER NOT NULL CHECK (verify_first IN (0, 1)),
    explanation_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
      (fit_points BETWEEN 0 AND 9 AND fit_band = 'low')
      OR (fit_points BETWEEN 10 AND 19 AND fit_band = 'medium')
      OR (fit_points BETWEEN 20 AND 30 AND fit_band = 'high')
    ),
    CHECK (
      (timing_millipoints BETWEEN 0 AND 7999 AND timing_band = 'cold')
      OR (timing_millipoints BETWEEN 8000 AND 19999 AND timing_band = 'warm')
      OR (timing_millipoints BETWEEN 20000 AND 40000 AND timing_band = 'hot')
    ),
    CHECK (priority <> 'p0' OR reachability = 'direct')
  )`,
  `CREATE TABLE prospect_priority_projection (
    prospect_id TEXT PRIMARY KEY REFERENCES prospects(id),
    rule_version_id TEXT NOT NULL REFERENCES prioritization_rule_versions(id),
    evaluation_id TEXT NOT NULL REFERENCES prioritization_evaluations(id),
    fit_points INTEGER NOT NULL CHECK (fit_points BETWEEN 0 AND 30),
    fit_band TEXT NOT NULL CHECK (fit_band IN ('low','medium','high')),
    timing_millipoints INTEGER NOT NULL CHECK (timing_millipoints BETWEEN 0 AND 40000),
    timing_band TEXT NOT NULL CHECK (timing_band IN ('cold','warm','hot')),
    reachability TEXT NOT NULL CHECK (reachability IN ('direct','indirect','none')),
    data_confidence INTEGER NOT NULL CHECK (data_confidence BETWEEN 0 AND 10),
    priority TEXT NOT NULL CHECK (priority IN ('p0','p1','p2','p3')),
    earliest_trigger_expires_at TEXT,
    verify_first INTEGER NOT NULL CHECK (verify_first IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    evaluated_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (fit_points BETWEEN 0 AND 9 AND fit_band = 'low')
      OR (fit_points BETWEEN 10 AND 19 AND fit_band = 'medium')
      OR (fit_points BETWEEN 20 AND 30 AND fit_band = 'high')
    ),
    CHECK (
      (timing_millipoints BETWEEN 0 AND 7999 AND timing_band = 'cold')
      OR (timing_millipoints BETWEEN 8000 AND 19999 AND timing_band = 'warm')
      OR (timing_millipoints BETWEEN 20000 AND 40000 AND timing_band = 'hot')
    ),
    CHECK (priority <> 'p0' OR reachability = 'direct')
  )`,
  `CREATE INDEX prospect_priority_priority_idx
    ON prospect_priority_projection(
      priority, earliest_trigger_expires_at, timing_millipoints,
      fit_points, reachability, data_confidence
    )`,
  `CREATE TABLE priority_overrides (
    id TEXT PRIMARY KEY,
    prospect_id TEXT NOT NULL REFERENCES prospects(id),
    override_kind TEXT NOT NULL CHECK (
      override_kind IN ('priority','pin_to_top','snooze','dismiss')
    ),
    priority TEXT CHECK (priority IN ('p0','p1','p2','p3')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
      (override_kind = 'priority' AND priority IS NOT NULL)
      OR (override_kind <> 'priority' AND priority IS NULL)
    )
  )`,
  `CREATE TABLE opt_out_tombstones (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL UNIQUE REFERENCES persons(id),
    requested_at TEXT NOT NULL,
    observed_channel TEXT NOT NULL,
    source_activity_id TEXT,
    evidence_ref TEXT,
    policy_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (source_activity_id, person_id) REFERENCES activities(id, person_id)
  )`,
  `CREATE TABLE opt_out_handles (
    id TEXT PRIMARY KEY,
    tombstone_id TEXT NOT NULL REFERENCES opt_out_tombstones(id),
    kind TEXT NOT NULL CHECK (kind IN ('phone','email')),
    normalized_value TEXT NOT NULL CHECK (length(normalized_value) > 0),
    created_at TEXT NOT NULL,
    UNIQUE (tombstone_id, kind, normalized_value)
  )`,
  `CREATE INDEX opt_out_handles_lookup_idx
    ON opt_out_handles(kind, normalized_value)`,
  `CREATE TABLE workspace_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    timezone TEXT NOT NULL,
    daily_dial_capacity INTEGER NOT NULL CHECK (daily_dial_capacity >= 0),
    daily_conversation_target INTEGER NOT NULL CHECK (daily_conversation_target >= 0),
    exploration_slots INTEGER NOT NULL CHECK (exploration_slots >= 0),
    resurface_suppression_days INTEGER NOT NULL CHECK (resurface_suppression_days >= 0),
    active_prioritization_rule_version_id TEXT
      REFERENCES prioritization_rule_versions(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
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
  `CREATE TRIGGER protect_cadence_enrollment_step_insert
    BEFORE INSERT ON cadence_enrollments
    WHEN NEW.current_step_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM cadence_steps AS step
        WHERE step.id = NEW.current_step_id
          AND step.cadence_definition_id = NEW.cadence_definition_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'cadence enrollment step must belong to its definition');
    END`,
  `CREATE TRIGGER protect_cadence_enrollment_step_update
    BEFORE UPDATE OF current_step_id, cadence_definition_id ON cadence_enrollments
    WHEN NEW.current_step_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM cadence_steps AS step
        WHERE step.id = NEW.current_step_id
          AND step.cadence_definition_id = NEW.cadence_definition_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'cadence enrollment step must belong to its definition');
    END`,
  `CREATE TRIGGER protect_cadence_enrollment_identity
    BEFORE UPDATE OF sales_cycle_id, cadence_definition_id, anchor_at, mode,
      allowed_step_ids_json ON cadence_enrollments
    WHEN NEW.sales_cycle_id IS NOT OLD.sales_cycle_id
      OR NEW.cadence_definition_id IS NOT OLD.cadence_definition_id
      OR NEW.anchor_at IS NOT OLD.anchor_at
      OR NEW.mode IS NOT OLD.mode
      OR NEW.allowed_step_ids_json IS NOT OLD.allowed_step_ids_json
    BEGIN
      SELECT RAISE(ABORT, 'cadence enrollment ownership and effective plan are immutable');
    END`,
  `CREATE TRIGGER protect_cadence_enrollment_status
    BEFORE UPDATE OF status ON cadence_enrollments
    WHEN OLD.status <> 'active' AND NEW.status IS NOT OLD.status
    BEGIN
      SELECT RAISE(ABORT, 'cadence enrollment status is one-way');
    END`,
  `CREATE TRIGGER protect_cadence_enrollment_delete
    BEFORE DELETE ON cadence_enrollments
    BEGIN
      SELECT RAISE(ABORT, 'cadence enrollments are retained permanently');
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
  `CREATE TRIGGER protect_next_action_delete
    BEFORE DELETE ON next_actions
    BEGIN
      SELECT RAISE(ABORT, 'next actions are retained permanently');
    END`,
  `CREATE TRIGGER protect_activity_cadence_insert
    BEFORE INSERT ON activities
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
         AND component.channel = NEW.channel
        WHERE enrollment.id = NEW.cadence_enrollment_id
          AND enrollment.sales_cycle_id = NEW.sales_cycle_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'Activity cadence evidence must share one owner graph and channel');
    END`,
  `CREATE TRIGGER protect_activity_cadence_update
    BEFORE UPDATE OF sales_cycle_id, cadence_enrollment_id, cadence_step_id,
      cadence_component_id, channel ON activities
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
         AND component.channel = NEW.channel
        WHERE enrollment.id = NEW.cadence_enrollment_id
          AND enrollment.sales_cycle_id = NEW.sales_cycle_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'Activity cadence evidence must share one owner graph and channel');
    END`,
  `CREATE TRIGGER protect_prospect_original_source
    BEFORE UPDATE OF original_source_event_id ON prospects
    WHEN NEW.original_source_event_id IS NOT OLD.original_source_event_id
    BEGIN
      SELECT RAISE(ABORT, 'original acquisition source is immutable');
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
  `CREATE TRIGGER protect_opted_out_active_cadence
    BEFORE INSERT ON cadence_enrollments
    WHEN NEW.status = 'active'
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
      SELECT RAISE(ABORT, 'opted-out person cannot enter an active cadence');
    END`,
  `CREATE TRIGGER protect_opted_out_active_cadence_update
    BEFORE UPDATE OF status, sales_cycle_id ON cadence_enrollments
    WHEN NEW.status = 'active'
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
      SELECT RAISE(ABORT, 'opted-out person cannot enter an active cadence');
    END`,
  `CREATE TRIGGER protect_trigger_event_ownership
    BEFORE INSERT ON trigger_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM prospects AS prospect
      JOIN source_events AS source ON source.id = NEW.source_event_id
      WHERE prospect.id = NEW.prospect_id
        AND prospect.person_id = source.person_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'trigger evidence must belong to the prospect person');
    END`,
  `CREATE TRIGGER protect_priority_projection_fidelity
    BEFORE INSERT ON prospect_priority_projection
    WHEN NOT EXISTS (
      SELECT 1
      FROM prioritization_evaluations AS evaluation
      WHERE evaluation.id = NEW.evaluation_id
        AND evaluation.prospect_id = NEW.prospect_id
        AND evaluation.rule_version_id = NEW.rule_version_id
        AND evaluation.fit_points = NEW.fit_points
        AND evaluation.fit_band = NEW.fit_band
        AND evaluation.timing_millipoints = NEW.timing_millipoints
        AND evaluation.timing_band = NEW.timing_band
        AND evaluation.reachability = NEW.reachability
        AND evaluation.data_confidence = NEW.data_confidence
        AND evaluation.priority = NEW.priority
        AND evaluation.earliest_trigger_expires_at IS NEW.earliest_trigger_expires_at
        AND evaluation.verify_first = NEW.verify_first
        AND evaluation.evaluated_at = NEW.evaluated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'priority projection must faithfully copy its evaluation');
    END`,
  `CREATE TRIGGER protect_priority_projection_fidelity_update
    BEFORE UPDATE ON prospect_priority_projection
    WHEN NOT EXISTS (
      SELECT 1
      FROM prioritization_evaluations AS evaluation
      WHERE evaluation.id = NEW.evaluation_id
        AND evaluation.prospect_id = NEW.prospect_id
        AND evaluation.rule_version_id = NEW.rule_version_id
        AND evaluation.fit_points = NEW.fit_points
        AND evaluation.fit_band = NEW.fit_band
        AND evaluation.timing_millipoints = NEW.timing_millipoints
        AND evaluation.timing_band = NEW.timing_band
        AND evaluation.reachability = NEW.reachability
        AND evaluation.data_confidence = NEW.data_confidence
        AND evaluation.priority = NEW.priority
        AND evaluation.earliest_trigger_expires_at IS NEW.earliest_trigger_expires_at
        AND evaluation.verify_first = NEW.verify_first
        AND evaluation.evaluated_at = NEW.evaluated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'priority projection must faithfully copy its evaluation');
    END`,
  `CREATE TRIGGER protect_priority_projection_owner
    BEFORE UPDATE OF prospect_id ON prospect_priority_projection
    WHEN NEW.prospect_id IS NOT OLD.prospect_id
    BEGIN
      SELECT RAISE(ABORT, 'priority projection owner is immutable');
    END`,
  `CREATE TRIGGER protect_p0_priority_override
    BEFORE INSERT ON priority_overrides
    WHEN NEW.override_kind = 'priority' AND NEW.priority = 'p0'
      AND NEW.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND NOT EXISTS (
        SELECT 1 FROM prospect_priority_projection AS projection
        WHERE projection.prospect_id = NEW.prospect_id
          AND projection.reachability = 'direct'
      )
    BEGIN
      SELECT RAISE(ABORT, 'P0 override requires a Direct current projection');
    END`,
  `CREATE TRIGGER protect_p0_priority_override_update
    BEFORE UPDATE OF prospect_id, override_kind, priority, expires_at ON priority_overrides
    WHEN NEW.override_kind = 'priority' AND NEW.priority = 'p0'
      AND NEW.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND NOT EXISTS (
        SELECT 1 FROM prospect_priority_projection AS projection
        WHERE projection.prospect_id = NEW.prospect_id
          AND projection.reachability = 'direct'
      )
    BEGIN
      SELECT RAISE(ABORT, 'P0 override requires a Direct current projection');
    END`,
  `CREATE TRIGGER protect_projection_p0_override_update
    BEFORE UPDATE ON prospect_priority_projection
    WHEN NEW.reachability <> 'direct'
      AND EXISTS (
        SELECT 1 FROM priority_overrides AS priority_override
        WHERE priority_override.prospect_id = OLD.prospect_id
          AND priority_override.override_kind = 'priority'
          AND priority_override.priority = 'p0'
          AND priority_override.expires_at
            > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    BEGIN
      SELECT RAISE(ABORT, 'P0 override requires a Direct current projection');
    END`,
  `CREATE TRIGGER protect_projection_p0_override_delete
    BEFORE DELETE ON prospect_priority_projection
    WHEN EXISTS (
      SELECT 1 FROM priority_overrides AS priority_override
      WHERE priority_override.prospect_id = OLD.prospect_id
        AND priority_override.override_kind = 'priority'
        AND priority_override.priority = 'p0'
        AND priority_override.expires_at
          > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    BEGIN
      SELECT RAISE(ABORT, 'P0 override requires a current projection');
    END`,
  `CREATE TRIGGER protect_reactivation_rule_update
    BEFORE UPDATE ON reactivation_rules
    WHEN NOT (
      NEW.id IS OLD.id
      AND NEW.sales_cycle_id IS OLD.sales_cycle_id
      AND NEW.rule_type IS OLD.rule_type
      AND NEW.due_at IS OLD.due_at
      AND NEW.matcher_json IS OLD.matcher_json
      AND NEW.version IS OLD.version
      AND NEW.created_at IS OLD.created_at
      AND (
        (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL)
        OR NEW.consumed_at IS OLD.consumed_at
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'reactivation definition and consumption are immutable');
    END`,
  `CREATE TRIGGER protect_reactivation_rule_delete
    BEFORE DELETE ON reactivation_rules
    BEGIN
      SELECT RAISE(ABORT, 'reactivation rules cannot be deleted');
    END`,
  `CREATE TRIGGER protect_lifecycle_review_item_identity
    BEFORE UPDATE OF activation_key, person_id, prospect_id, source_cycle_id,
      reactivation_rule_id, source_event_id, reason, payload_json,
      created_at ON lifecycle_review_items
    WHEN NEW.activation_key IS NOT OLD.activation_key
      OR NEW.person_id IS NOT OLD.person_id
      OR NEW.prospect_id IS NOT OLD.prospect_id
      OR NEW.source_cycle_id IS NOT OLD.source_cycle_id
      OR NEW.reactivation_rule_id IS NOT OLD.reactivation_rule_id
      OR NEW.source_event_id IS NOT OLD.source_event_id
      OR NEW.reason IS NOT OLD.reason
      OR NEW.payload_json IS NOT OLD.payload_json
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'lifecycle review ownership and command are immutable');
    END`,
  `CREATE TRIGGER protect_lifecycle_review_item_delete
    BEFORE DELETE ON lifecycle_review_items
    BEGIN
      SELECT RAISE(ABORT, 'lifecycle review items are retained permanently');
    END`,
  `CREATE TRIGGER protect_lifecycle_review_item_resolution
    BEFORE UPDATE OF status, resolution_json, resolved_at, version, updated_at
      ON lifecycle_review_items
    WHEN NOT (
      OLD.status = 'open'
      AND NEW.status = 'resolved'
      AND OLD.resolution_json IS NULL
      AND NEW.resolution_json IS NOT NULL
      AND OLD.resolved_at IS NULL
      AND NEW.resolved_at IS NOT NULL
      AND NEW.version = OLD.version + 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'lifecycle review resolution is one-way and CAS-versioned');
    END`,
  `CREATE TRIGGER protect_source_intake_receipt_prospect
    BEFORE INSERT ON source_intake_receipts
    FOR EACH ROW
    WHEN EXISTS (
      SELECT 1
      FROM source_events
      WHERE id = NEW.source_event_id
        AND prospect_id IS NOT NULL
        AND prospect_id <> NEW.prospect_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'source intake receipt prospect must match source event');
    END`,
  ...immutableTriggers('source_events'),
  ...immutableTriggers('source_intake_receipts'),
  ...immutableTriggers('activities'),
  ...immutableTriggers('activity_amendments'),
  ...immutableTriggers('stage_events'),
  ...immutableTriggers('consent_policy_records'),
  ...immutableTriggers('cycle_reactivation_receipts'),
  ...immutableTriggers('won_terms'),
  ...immutableTriggers('trigger_events'),
  ...immutableTriggers('prioritization_evaluations'),
  ...immutableTriggers('cadence_definitions'),
  ...immutableTriggers('cadence_steps'),
  ...immutableTriggers('cadence_action_components'),
  ...immutableTriggers('prioritization_rule_versions'),
  `CREATE TRIGGER protect_opt_out_tombstone_active_cadence
    BEFORE INSERT ON opt_out_tombstones
    WHEN EXISTS (
      SELECT 1 FROM sales_cycles AS cycle
      WHERE cycle.person_id = NEW.person_id
        AND cycle.workflow_status IN ('active','onboarding')
    ) OR EXISTS (
      SELECT 1
      FROM sales_cycles AS cycle
      JOIN cadence_enrollments AS enrollment
        ON enrollment.sales_cycle_id = cycle.id
      WHERE cycle.person_id = NEW.person_id
        AND enrollment.status = 'active'
    ) OR EXISTS (
      SELECT 1
      FROM sales_cycles AS cycle
      JOIN next_actions AS action ON action.sales_cycle_id = cycle.id
      WHERE cycle.person_id = NEW.person_id
        AND action.status = 'pending'
        AND action.channel IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'open lifecycle work must close before permanent opt-out');
    END`,
  `CREATE TRIGGER synchronize_person_opt_out
    AFTER INSERT ON opt_out_tombstones
    BEGIN
      UPDATE persons
      SET opted_out = 1,
          opted_out_at = NEW.requested_at,
          version = version + 1,
          updated_at = NEW.requested_at
      WHERE id = NEW.person_id;
    END`,
  `CREATE TRIGGER protect_person_opt_out_reset
    BEFORE UPDATE OF opted_out, opted_out_at ON persons
    WHEN EXISTS (
      SELECT 1 FROM opt_out_tombstones AS tombstone
      WHERE tombstone.person_id = OLD.id
    )
      AND NOT EXISTS (
        SELECT 1 FROM opt_out_tombstones AS tombstone
        WHERE tombstone.person_id = OLD.id
          AND NEW.opted_out = 1
          AND NEW.opted_out_at = tombstone.requested_at
      )
    BEGIN
      SELECT RAISE(ABORT, 'permanent opt-out cannot be reset or changed');
    END`,
  `CREATE TRIGGER protect_opt_out_tombstone
    BEFORE DELETE ON opt_out_tombstones
    BEGIN
      SELECT RAISE(ABORT, 'opt-out tombstones cannot be deleted');
    END`,
  `CREATE TRIGGER protect_opt_out_tombstone_update
    BEFORE UPDATE ON opt_out_tombstones
    BEGIN
      SELECT RAISE(ABORT, 'opt-out tombstones cannot be updated');
    END`,
  `CREATE TRIGGER protect_opt_out_handle
    BEFORE DELETE ON opt_out_handles
    BEGIN
      SELECT RAISE(ABORT, 'opt-out handles cannot be deleted');
    END`,
  `CREATE TRIGGER protect_opt_out_handle_update
    BEFORE UPDATE ON opt_out_handles
    BEGIN
      SELECT RAISE(ABORT, 'opt-out handles cannot be updated');
    END`,
] as const;

function immutableTriggers(table: string): readonly string[] {
  return [
    `CREATE TRIGGER immutable_${table}
      BEFORE UPDATE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} rows are immutable');
      END`,
    `CREATE TRIGGER immutable_${table}_delete
      BEFORE DELETE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} rows are immutable');
      END`,
  ];
}

export const migration0002DomainFoundation = {
  async up(db: Kysely<FoundationDatabase>) {
    for (const statement of domainStatements) {
      await sql.raw(statement).execute(db);
    }

    const timestamp = new Date().toISOString();
    await sql`
      INSERT INTO workspace_settings (
        singleton, timezone, daily_dial_capacity, daily_conversation_target,
        exploration_slots, resurface_suppression_days, created_at, updated_at
      ) VALUES (1, 'America/New_York', 40, 5, 2, 3, ${timestamp}, ${timestamp})
    `.execute(db);

    await sql`
      UPDATE app_meta
      SET schema_version = 2, updated_at = ${timestamp}
      WHERE singleton = 1
    `.execute(db);
  },
};
