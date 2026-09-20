-- 0007_research
--
-- Research discovery and enrichment (specification revision 3: 1.1 invariant 8, 7.4,
-- 9.1's route eligibility, 10.3's evidence retention, 13.2, and Appendix C's
-- `research:{query_hash}:{page_hash}` and `research-firm:{firm}:{revision}`).
--
-- Additive only. Migrations 0001 to 0004 are never edited; every object below is new.
--
-- Five things run through the file.
--
--   * **Research never contacts anybody.** There is no column here that could hold an
--     enrollment, a send, a dial ticket or an opportunity. Invariant 8 is a property
--     of the schema first: the only business rows research may write are firms,
--     contacts, routes, evidence, coordinates and *suggestions*, and a suggestion is
--     inert until a person acts on it.
--   * **A candidate is not a usable route.** Section 7.4 makes `usable` the decision
--     of a versioned provider/source policy. `research_route_policies` is that policy,
--     insert-only so that "admin-editable thresholds with history" is the table's
--     shape rather than a convention, and the version it names is written onto every
--     route it promotes (migration 0004's `eligibility_policy_version`).
--   * **Every provider call is counted, priced and, when it fails, named.** Section
--     7.4: "Provider calls, costs, failures, and evidence retention are capped and
--     audited." The ceiling that stops enqueues is G5's `daily_counters`; the money
--     and the failures are `research_provider_ledger`, keyed by the workspace business
--     date like every other cap (Appendix D).
--   * **A firm's zone comes from its coordinates first.** `firm_locations` is the
--     source `resolveFirmZone` prefers, ahead of G3a's two-state postal table, and
--     `firms.time_zone_source = 'coordinates'` was already admitted by migration
--     0004's CHECK. See docs/decisions/g10-coordinate-zone-source.md.
--   * **Appendix C's two keys are unique constraints.** `research_pages` is unique on
--     `(workspace, query_hash, page_hash)` and `research_firm_runs` on `(workspace,
--     firm, revision)`, which is what makes both handlers' declared
--     `business_uniqueness` protection true rather than hopeful.
--
-- Seeded rows carry a named constant instant rather than now().

-- ---------------------------------------------------------------------------
-- research_settings (specification 7.4, 10.1)
--
-- "Admins maintain ... sending limits, research limits, route-eligibility
-- thresholds". One row per workspace, seeded disabled: a workspace that has never
-- been configured must not research, because the conservative reading of "capped and
-- audited" is that an unreviewed budget is no budget.
-- ---------------------------------------------------------------------------
CREATE TABLE research_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  enabled boolean NOT NULL DEFAULT false,
  -- Discovery pages and firm enrichments per workspace business date. Both are
  -- enforced through G5's increment-with-ceiling, never by a read followed by a write.
  daily_page_ceiling integer NOT NULL DEFAULT 20,
  daily_firm_ceiling integer NOT NULL DEFAULT 200,
  daily_cost_ceiling_micros bigint NOT NULL DEFAULT 2000000,
  max_pages_per_firm integer NOT NULL DEFAULT 4,
  max_page_bytes integer NOT NULL DEFAULT 1000000,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_settings_pkey PRIMARY KEY (workspace_id),
  CONSTRAINT research_settings_editor_fkey FOREIGN KEY (workspace_id, updated_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT research_settings_page_ceiling_range CHECK (daily_page_ceiling BETWEEN 0 AND 10000),
  CONSTRAINT research_settings_firm_ceiling_range CHECK (daily_firm_ceiling BETWEEN 0 AND 100000),
  CONSTRAINT research_settings_cost_ceiling_nonnegative CHECK (daily_cost_ceiling_micros >= 0),
  CONSTRAINT research_settings_pages_per_firm_range CHECK (max_pages_per_firm BETWEEN 1 AND 10),
  CONSTRAINT research_settings_page_bytes_range CHECK (max_page_bytes BETWEEN 1024 AND 1000000),
  CONSTRAINT research_settings_updated_not_before_created CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- research_providers (specification 7.4, 10.3)
--
-- "discovery through approved providers". Approved means a row here, enabled by an
-- admin, with its reviewed per-call cost and its own daily call ceiling — so a
-- provider whose terms or price changed is disabled in one place and every path that
-- would have called it is refused.
--
-- `terms_allow_retention` and `retention_days` are section 10.3's "research evidence:
-- with the firm while provider terms permit", carried on the provider rather than
-- guessed per result. Migration 0004's `evidence_items_retention_consistent` already
-- refuses evidence whose terms forbid retention and which carries no expiry; this is
-- where the expiry comes from.
-- ---------------------------------------------------------------------------
CREATE TABLE research_providers (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  provider_key text NOT NULL,
  kind text NOT NULL,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  cost_per_call_micros bigint NOT NULL DEFAULT 0,
  daily_call_ceiling integer NOT NULL DEFAULT 0,
  terms_allow_retention boolean NOT NULL DEFAULT true,
  retention_days integer,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_providers_pkey PRIMARY KEY (workspace_id, provider_key),
  CONSTRAINT research_providers_editor_fkey FOREIGN KEY (workspace_id, updated_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  -- The same shape `evidence_items.provider` accepts, so a ledger row and the evidence
  -- it paid for name the provider identically.
  CONSTRAINT research_providers_key_shape CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT research_providers_kind_known CHECK (kind IN ('discovery', 'page', 'extraction')),
  CONSTRAINT research_providers_display_name_present
    CHECK (btrim(display_name) <> '' AND length(display_name) <= 120),
  CONSTRAINT research_providers_cost_nonnegative CHECK (cost_per_call_micros >= 0),
  CONSTRAINT research_providers_ceiling_range CHECK (daily_call_ceiling BETWEEN 0 AND 100000),
  CONSTRAINT research_providers_retention_consistent
    CHECK (terms_allow_retention OR retention_days IS NOT NULL),
  CONSTRAINT research_providers_retention_days_range
    CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
  CONSTRAINT research_providers_updated_not_before_created CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- research_provider_ledger (specification 7.4, Appendix D)
--
-- Calls, cost and failures per provider per workspace business date. Separate from
-- `daily_counters` on purpose: a counter is one integer with a ceiling, and this is
-- three numbers and the last failure code, which an operator reads to answer "what
-- did research spend and what refused it today".
--
-- The business date is stored beside the zone that produced it, exactly as
-- `daily_counters` does, so changing the workspace zone later cannot re-date spend.
-- ---------------------------------------------------------------------------
CREATE TABLE research_provider_ledger (
  workspace_id uuid NOT NULL,
  provider_key text NOT NULL,
  business_date date NOT NULL,
  business_time_zone text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  last_failure_code text,
  last_failure_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_provider_ledger_pkey PRIMARY KEY (workspace_id, provider_key, business_date),
  CONSTRAINT research_provider_ledger_provider_fkey FOREIGN KEY (workspace_id, provider_key)
    REFERENCES research_providers (workspace_id, provider_key),
  CONSTRAINT research_provider_ledger_calls_nonnegative CHECK (calls >= 0),
  CONSTRAINT research_provider_ledger_failures_nonnegative CHECK (failures >= 0),
  CONSTRAINT research_provider_ledger_failures_within_calls CHECK (failures <= calls),
  CONSTRAINT research_provider_ledger_cost_nonnegative CHECK (cost_micros >= 0),
  CONSTRAINT research_provider_ledger_failure_code_shape
    CHECK (last_failure_code IS NULL OR last_failure_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT research_provider_ledger_failure_recorded
    CHECK ((last_failure_code IS NULL) = (last_failure_at IS NULL)),
  CONSTRAINT research_provider_ledger_business_time_zone_shape
    CHECK (business_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$')
);

-- ---------------------------------------------------------------------------
-- research_route_policies (specification 7.4, 9.1, 10.1) — insert-only
--
-- "Email and phone routes become `usable` only when a versioned provider/source
-- policy satisfies both technical-validation and association-confidence thresholds."
--
-- Insert-only is what makes the history real. An admin does not edit a threshold; an
-- admin publishes a new version with its own `effective_from`, and the routes
-- promoted under the previous version stay findable by `eligibility_policy_version`.
-- UPDATE and DELETE are revoked below, like `audit_events`.
--
-- The active policy is the newest row whose `effective_from` has arrived. Zero rows
-- is not "no thresholds": it fails closed, because a route promoted with no policy
-- version is refused by migration 0004's `*_usable_is_evidenced` CHECK anyway.
-- ---------------------------------------------------------------------------
CREATE TABLE research_route_policies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  version text NOT NULL,
  minimum_association_confidence numeric(4, 3) NOT NULL,
  require_technical_validation boolean NOT NULL DEFAULT true,
  trusted_sources text[] NOT NULL DEFAULT ARRAY[]::text[],
  note text,
  created_by_user_id uuid,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_route_policies_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT research_route_policies_version_unique UNIQUE (workspace_id, version),
  CONSTRAINT research_route_policies_author_fkey FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  -- The same shape migration 0004 accepts in `eligibility_policy_version`, so a
  -- published policy can always be written onto the routes it promotes.
  CONSTRAINT research_route_policies_version_shape CHECK (version ~ '^[a-z0-9._-]{1,40}$'),
  CONSTRAINT research_route_policies_confidence_range
    CHECK (minimum_association_confidence >= 0 AND minimum_association_confidence <= 1),
  CONSTRAINT research_route_policies_trusted_sources_known
    CHECK (trusted_sources <@ ARRAY['research_provider', 'salesperson', 'import', 'website', 'reply']::text[]),
  CONSTRAINT research_route_policies_note_bounded
    CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500))
);

CREATE INDEX research_route_policies_by_effective_from
  ON research_route_policies (workspace_id, effective_from DESC, created_at DESC);

-- ---------------------------------------------------------------------------
-- research_pages (specification 7.4, 13.2, Appendix C)
--
-- One row per discovery page, keyed by the two hashes Appendix C names. The unique
-- constraint *is* the handler's "provider result/evidence uniqueness": a
-- `research.page` job replayed after a crash finds the row and finishes rather than
-- calling the provider again.
--
-- `outcome` distinguishes a page that was refused before any provider call (a
-- ceiling, a disabled provider, a suppression) from one that failed during it. Both
-- are terminal and both name a reason; only `running` has no completion.
-- ---------------------------------------------------------------------------
CREATE TABLE research_pages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  provider_key text NOT NULL,
  query_hash text NOT NULL,
  page_hash text NOT NULL,
  query_text text NOT NULL,
  page_token text,
  requested_by_user_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome text NOT NULL DEFAULT 'running',
  refusal_code text,
  candidate_count integer NOT NULL DEFAULT 0,
  firms_created integer NOT NULL DEFAULT 0,
  evidence_recorded integer NOT NULL DEFAULT 0,
  skipped jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_micros bigint NOT NULL DEFAULT 0,
  CONSTRAINT research_pages_pkey PRIMARY KEY (workspace_id, id),
  -- Appendix C: `research:{query_hash}:{page_hash}`.
  CONSTRAINT research_pages_one_per_result UNIQUE (workspace_id, query_hash, page_hash),
  CONSTRAINT research_pages_provider_fkey FOREIGN KEY (workspace_id, provider_key)
    REFERENCES research_providers (workspace_id, provider_key),
  CONSTRAINT research_pages_requester_fkey FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT research_pages_query_hash_shape CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT research_pages_page_hash_shape CHECK (page_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT research_pages_query_text_present
    CHECK (btrim(query_text) <> '' AND length(query_text) <= 500),
  CONSTRAINT research_pages_page_token_bounded
    CHECK (page_token IS NULL OR (btrim(page_token) <> '' AND length(page_token) <= 4096)),
  CONSTRAINT research_pages_outcome_known CHECK (outcome IN ('running', 'completed', 'refused', 'failed')),
  CONSTRAINT research_pages_completion_consistent CHECK ((outcome = 'running') = (completed_at IS NULL)),
  CONSTRAINT research_pages_refusal_consistent
    CHECK ((outcome IN ('refused', 'failed')) = (refusal_code IS NOT NULL)),
  CONSTRAINT research_pages_refusal_code_shape
    CHECK (refusal_code IS NULL OR refusal_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT research_pages_candidate_count_nonnegative CHECK (candidate_count >= 0),
  CONSTRAINT research_pages_firms_created_within_candidates
    CHECK (firms_created >= 0 AND firms_created <= candidate_count),
  CONSTRAINT research_pages_evidence_recorded_nonnegative CHECK (evidence_recorded >= 0),
  CONSTRAINT research_pages_cost_nonnegative CHECK (cost_micros >= 0),
  CONSTRAINT research_pages_skipped_is_object CHECK (jsonb_typeof(skipped) = 'object')
);

CREATE INDEX research_pages_by_query ON research_pages (workspace_id, query_hash, requested_at DESC);

-- ---------------------------------------------------------------------------
-- firm_locations (specification 9.2, and the coordinator's 20 September note)
--
-- The coordinate a discovery provider returned for a firm, and the source that
-- returned it. This is the *primary* zone source: a latitude and longitude place a
-- firm on one side of a time-zone boundary, and a three-digit postal prefix does not.
-- G3a's two-state postal table remains the fallback for hand-entered firms and is
-- deliberately not grown (docs/decisions/g3a-postal-zone-table.md, and
-- docs/decisions/g10-coordinate-zone-source.md).
--
-- One row per firm: the newest retrieval replaces the previous coordinate, and
-- `retrieved_at` says when. The evidence item for the listing keeps the history.
-- ---------------------------------------------------------------------------
CREATE TABLE firm_locations (
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  latitude numeric(8, 5) NOT NULL,
  longitude numeric(8, 5) NOT NULL,
  provider_key text NOT NULL,
  source_reference text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_locations_pkey PRIMARY KEY (workspace_id, firm_id),
  CONSTRAINT firm_locations_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id) ON UPDATE CASCADE,
  CONSTRAINT firm_locations_latitude_range CHECK (latitude >= -90 AND latitude <= 90),
  CONSTRAINT firm_locations_longitude_range CHECK (longitude >= -180 AND longitude <= 180),
  CONSTRAINT firm_locations_provider_key_shape CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT firm_locations_source_reference_present
    CHECK (btrim(source_reference) <> '' AND length(source_reference) <= 500),
  CONSTRAINT firm_locations_updated_not_before_created CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- research_firm_runs (specification 7.4, 13.2, Appendix C)
--
-- One row per enrichment of one firm at one revision — Appendix C's
-- `research-firm:{firm}:{revision}`, and the "firm/evidence revision" that protects
-- the handler. The revision is the number of runs the firm has already had plus one,
-- so a second request for the same firm is a new revision and a new row, while a
-- replayed job for the revision it was materialized with finds the row it wrote.
-- ---------------------------------------------------------------------------
CREATE TABLE research_firm_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  revision integer NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome text NOT NULL DEFAULT 'running',
  refusal_code text,
  evidence_recorded integer NOT NULL DEFAULT 0,
  suggestions_created integer NOT NULL DEFAULT 0,
  routes_promoted integer NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  CONSTRAINT research_firm_runs_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT research_firm_runs_one_per_revision UNIQUE (workspace_id, firm_id, revision),
  CONSTRAINT research_firm_runs_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id) ON UPDATE CASCADE,
  CONSTRAINT research_firm_runs_revision_positive CHECK (revision >= 1),
  CONSTRAINT research_firm_runs_outcome_known
    CHECK (outcome IN ('running', 'completed', 'refused', 'failed')),
  CONSTRAINT research_firm_runs_completion_consistent CHECK ((outcome = 'running') = (completed_at IS NULL)),
  CONSTRAINT research_firm_runs_refusal_consistent
    CHECK ((outcome IN ('refused', 'failed')) = (refusal_code IS NOT NULL)),
  CONSTRAINT research_firm_runs_refusal_code_shape
    CHECK (refusal_code IS NULL OR refusal_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT research_firm_runs_evidence_nonnegative CHECK (evidence_recorded >= 0),
  CONSTRAINT research_firm_runs_suggestions_nonnegative CHECK (suggestions_created >= 0),
  CONSTRAINT research_firm_runs_routes_nonnegative CHECK (routes_promoted >= 0),
  CONSTRAINT research_firm_runs_cost_nonnegative CHECK (cost_micros >= 0)
);

CREATE INDEX research_firm_runs_by_firm ON research_firm_runs (workspace_id, firm_id, revision DESC);

-- ---------------------------------------------------------------------------
-- research_suggestions (specification 7.2, 7.4)
--
-- "Lower-confidence or conflicting facts remain visible suggestions and never
-- overwrite confirmed values", and "Research may suggest duplicates but never
-- performs a destructive merge automatically."
--
-- One table for all five kinds, because they are the same thing: something research
-- believes, recorded where a person can see it, with no effect until that person
-- accepts it. `applied` is the one state research may write itself, and only for the
-- narrow case section 7.4 permits — a high-confidence *non-contact* fact filling a
-- canonical field that is empty. A contact, a route or a duplicate is never `applied`
-- by research; the CHECK below is what makes that a property of the database.
-- ---------------------------------------------------------------------------
CREATE TABLE research_suggestions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  kind text NOT NULL,
  field_key text,
  proposed_value text NOT NULL,
  confidence numeric(4, 3),
  provider_key text NOT NULL,
  evidence_id uuid,
  duplicate_firm_id uuid,
  dedupe_key text NOT NULL,
  state text NOT NULL DEFAULT 'proposed',
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_suggestions_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT research_suggestions_one_per_finding UNIQUE (workspace_id, firm_id, kind, dedupe_key),
  CONSTRAINT research_suggestions_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id) ON UPDATE CASCADE,
  CONSTRAINT research_suggestions_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT research_suggestions_evidence_fkey FOREIGN KEY (workspace_id, evidence_id)
    REFERENCES evidence_items (workspace_id, id),
  CONSTRAINT research_suggestions_duplicate_firm_fkey FOREIGN KEY (workspace_id, duplicate_firm_id)
    REFERENCES firms (workspace_id, id),
  CONSTRAINT research_suggestions_reviewer_fkey FOREIGN KEY (workspace_id, reviewed_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT research_suggestions_kind_known
    CHECK (kind IN ('canonical_field', 'contact', 'phone_route', 'email_route', 'duplicate_firm')),
  CONSTRAINT research_suggestions_field_key_consistent
    CHECK ((kind = 'canonical_field') = (field_key IS NOT NULL)),
  CONSTRAINT research_suggestions_field_key_shape
    CHECK (field_key IS NULL OR field_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT research_suggestions_duplicate_consistent
    CHECK ((kind = 'duplicate_firm') = (duplicate_firm_id IS NOT NULL)),
  CONSTRAINT research_suggestions_duplicate_not_self
    CHECK (duplicate_firm_id IS NULL OR duplicate_firm_id <> firm_id),
  CONSTRAINT research_suggestions_proposed_value_present
    CHECK (btrim(proposed_value) <> '' AND length(proposed_value) <= 500),
  CONSTRAINT research_suggestions_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT research_suggestions_provider_key_shape CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT research_suggestions_dedupe_key_present
    CHECK (btrim(dedupe_key) <> '' AND length(dedupe_key) <= 200),
  CONSTRAINT research_suggestions_state_known
    CHECK (state IN ('proposed', 'applied', 'accepted', 'rejected', 'superseded')),
  -- Section 7.4: only a high-confidence *non-contact* fact may fill a canonical field
  -- without a person. Everything else waits for one.
  CONSTRAINT research_suggestions_only_facts_apply
    CHECK (state <> 'applied' OR kind = 'canonical_field'),
  CONSTRAINT research_suggestions_review_consistent
    CHECK ((state IN ('accepted', 'rejected')) = (reviewed_by_user_id IS NOT NULL)),
  CONSTRAINT research_suggestions_review_time_recorded
    CHECK ((reviewed_by_user_id IS NULL) = (reviewed_at IS NULL)),
  CONSTRAINT research_suggestions_review_note_bounded
    CHECK (review_note IS NULL OR (btrim(review_note) <> '' AND length(review_note) <= 500)),
  CONSTRAINT research_suggestions_updated_not_before_created CHECK (updated_at >= created_at)
);

CREATE INDEX research_suggestions_open_by_firm
  ON research_suggestions (workspace_id, firm_id, created_at DESC)
  WHERE state = 'proposed';

-- ---------------------------------------------------------------------------
-- Seeding
--
-- A workspace needs its research settings row, its three approved-provider rows and
-- its first route-eligibility policy the moment it exists, for the same reason it
-- needs a pipeline: otherwise the first command has to invent them, and an invented
-- threshold is not a reviewed one. Providers arrive *disabled*, so seeding grants no
-- spend.
--
-- The seeded policy is `route-policy.1`, deliberately the same version string and the
-- same thresholds as `ROUTE_ELIGIBILITY_POLICY` in packages/domain/crm/routePolicy.ts,
-- so the routes G3a already promoted under it remain explicable.
-- ---------------------------------------------------------------------------
CREATE FUNCTION seed_research_configuration(target_workspace uuid, seeded_at timestamptz) RETURNS void
LANGUAGE sql AS $research$
  INSERT INTO research_settings (workspace_id, created_at, updated_at)
  VALUES (target_workspace, seeded_at, seeded_at)
  ON CONFLICT ON CONSTRAINT research_settings_pkey DO NOTHING;

  INSERT INTO research_providers (workspace_id, provider_key, kind, display_name, created_at, updated_at)
  VALUES
    (target_workspace, 'places',       'discovery',  'Places text search',   seeded_at, seeded_at),
    (target_workspace, 'company_page', 'page',       'Company page fetch',   seeded_at, seeded_at),
    (target_workspace, 'page_facts',   'extraction', 'Page fact extraction', seeded_at, seeded_at)
  ON CONFLICT ON CONSTRAINT research_providers_pkey DO NOTHING;

  INSERT INTO research_route_policies
    (workspace_id, version, minimum_association_confidence, require_technical_validation,
     trusted_sources, note, effective_from, created_at)
  VALUES
    (target_workspace, 'route-policy.1', 0.800, true, ARRAY['salesperson', 'reply']::text[],
     'The initial thresholds, identical to ROUTE_ELIGIBILITY_POLICY in @fss/domain/crm.',
     seeded_at, seeded_at)
  ON CONFLICT ON CONSTRAINT research_route_policies_version_unique DO NOTHING;
$research$;

CREATE FUNCTION seed_research_for_new_workspace() RETURNS trigger
LANGUAGE plpgsql AS $new_workspace_research$
BEGIN
  PERFORM seed_research_configuration(NEW.id, NEW.created_at);
  RETURN NULL;
END;
$new_workspace_research$;

CREATE TRIGGER workspaces_seed_research
  AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION seed_research_for_new_workspace();

-- Migrate, not expand: the workspaces that already existed get the same rows, at a
-- named constant instant rather than now().
SELECT seed_research_configuration(w.id, TIMESTAMPTZ '2026-09-20 00:00:00+00') FROM workspaces w;

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then. `research_route_policies` is insert-only, like `audit_events` and
-- `suppression_events`: publishing a new version is the only way to change a
-- threshold, which is what makes the history complete.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON research_settings TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON research_providers TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON research_provider_ledger TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON research_pages TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON firm_locations TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON research_firm_runs TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON research_suggestions TO app_runtime, migration;

GRANT SELECT, INSERT ON research_route_policies TO app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON research_route_policies FROM app_runtime, migration;
