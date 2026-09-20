-- 0004_crm
--
-- The CRM core (specification revision 3, 19 September 2026: sections 7.2, 7.3, 8.1
-- and 9.1, and Appendix G 7, 8 and 37). Firms, contacts, routes, evidence, pipeline
-- stages, opportunities, stage history, merges and the outbox the sequences and
-- Today lanes subscribe to.
--
-- Additive only. Migrations 0001 to 0003 are never edited; everything here is a new
-- table, a new index, or a trigger on `workspaces` that seeds the default pipeline.
--
-- Four rules run through the file.
--
--   * Every business table carries `workspace_id`, every lookup key begins with it,
--     and every foreign key between scoped tables is composite, so a cross-workspace
--     relationship is refused by the database rather than by a repository check.
--   * The **semantic composite keys** of section 7.2 — `(workspace_id, contact_id,
--     firm_id)` and `(workspace_id, opportunity_id, firm_id)` — are real unique keys
--     that child tables reference, so an enrollment, a route or a stage event cannot
--     mix firms even when both ids exist.
--   * Every promise the prose makes is a constraint with a failing-insert case in
--     `test/db/support/crmCases.ts`: one open opportunity per firm, one active primary
--     contact per firm, Lost needs a reason, a usable route needs its policy version.
--   * History tables are append-only by privilege, like `audit_events` in 0001:
--     `opportunity_stage_events`, `record_merge_events` and `crm_domain_events` grant
--     SELECT and INSERT and have UPDATE, DELETE and TRUNCATE revoked.
--
-- Seeded rows carry a named constant instant rather than now().

-- ---------------------------------------------------------------------------
-- firms (specification 7.2)
--
-- "canonical company record, assignee, website, location, state, postal data, actual
-- IANA zone, and confidence/source for inferred location facts."
--
-- The assignee is nullable with a MATCH SIMPLE composite foreign key, so an
-- unassigned firm skips the membership check entirely — that is the state a
-- discovered firm starts in — while an assigned one cannot point at a membership in
-- another workspace ("at most one assigned salesperson per firm").
--
-- The four time-zone columns are the record of section 9.2's versioned source rule.
-- `resolveFirmZone` in @fss/domain produces exactly one of two shapes and the CHECKs
-- below admit exactly those two: a zone with its confidence and source, or an
-- unresolved reason. A firm with neither has not been through the rule yet, and
-- `authorizeDial` (G4) refuses it for the same reason it refuses the unresolved one.
-- ---------------------------------------------------------------------------
CREATE TABLE firms (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  name text NOT NULL,
  assigned_user_id uuid,
  website text,
  address_line text,
  locality text,
  region_code text,
  postal_code text,
  country_code text NOT NULL DEFAULT 'US',
  -- The firm's actual IANA zone, and how it was established.
  time_zone text,
  time_zone_confidence text,
  time_zone_source text,
  time_zone_rule_version text,
  time_zone_unresolved_reason text,
  status text NOT NULL DEFAULT 'active',
  merged_into_firm_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firms_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT firms_assignee_fkey FOREIGN KEY (workspace_id, assigned_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT firms_merged_into_fkey FOREIGN KEY (workspace_id, merged_into_firm_id)
    REFERENCES firms (workspace_id, id),
  CONSTRAINT firms_name_present CHECK (btrim(name) <> '' AND length(name) <= 300),
  -- PostgreSQL's POSIX regular expressions cap a bounded repetition at 255, so the
  -- length limit is a separate term rather than a bigger `{m,n}`.
  CONSTRAINT firms_website_shape
    CHECK (website IS NULL OR (website ~ '^https?://[^[:space:]]{3,}$' AND length(website) <= 500)),
  CONSTRAINT firms_address_line_bounded
    CHECK (address_line IS NULL OR (btrim(address_line) <> '' AND length(address_line) <= 300)),
  CONSTRAINT firms_locality_bounded CHECK (locality IS NULL OR (btrim(locality) <> '' AND length(locality) <= 120)),
  CONSTRAINT firms_region_code_shape CHECK (region_code IS NULL OR region_code ~ '^[A-Z]{2}$'),
  CONSTRAINT firms_postal_code_shape CHECK (postal_code IS NULL OR postal_code ~ '^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$'),
  CONSTRAINT firms_country_code_shape CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT firms_time_zone_shape
    CHECK (time_zone IS NULL OR time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$'),
  CONSTRAINT firms_time_zone_confidence_known
    CHECK (time_zone_confidence IS NULL OR time_zone_confidence IN ('high', 'medium')),
  CONSTRAINT firms_time_zone_source_known
    CHECK (time_zone_source IS NULL
           OR time_zone_source IN ('recorded', 'postal', 'coordinates', 'state_default')),
  -- A zone never arrives without the confidence and the source that produced it.
  CONSTRAINT firms_zone_provenance_complete
    CHECK ((time_zone IS NULL) = (time_zone_confidence IS NULL)
           AND (time_zone IS NULL) = (time_zone_source IS NULL)),
  CONSTRAINT firms_zone_unresolved_reason_known
    CHECK (time_zone_unresolved_reason IS NULL
           OR time_zone_unresolved_reason IN ('no_location', 'state_spans_zones', 'state_unknown',
                                              'no_default_for_state')),
  -- Resolved or unresolved, never both: an unresolved reason beside a zone would let
  -- a caller read whichever one suited it.
  CONSTRAINT firms_zone_resolution_exclusive
    CHECK (time_zone IS NULL OR time_zone_unresolved_reason IS NULL),
  -- Either outcome names the rule version that produced it (section 9.2, Appendix D).
  CONSTRAINT firms_zone_rule_version_present
    CHECK ((time_zone IS NULL AND time_zone_unresolved_reason IS NULL) = (time_zone_rule_version IS NULL)),
  CONSTRAINT firms_status_known CHECK (status IN ('active', 'merged')),
  CONSTRAINT firms_merge_consistent CHECK ((status = 'merged') = (merged_into_firm_id IS NOT NULL)),
  CONSTRAINT firms_not_merged_into_self CHECK (merged_into_firm_id IS NULL OR merged_into_firm_id <> id),
  CONSTRAINT firms_updated_not_before_created CHECK (updated_at >= created_at)
);

CREATE INDEX firms_by_assignee ON firms (workspace_id, assigned_user_id) WHERE status = 'active';
CREATE INDEX firms_by_name ON firms (workspace_id, lower(name));

-- ---------------------------------------------------------------------------
-- contacts (specification 7.2)
--
-- "one active primary contact per firm is permitted but not required" — a partial
-- unique index, so zero is legal and two is not.
--
-- `contacts_semantic_key` is the composite section 7.2 names: other tables reference
-- `(workspace_id, id, firm_id)` rather than `(workspace_id, id)`, which is what makes
-- "an enrollment cannot mix firms" a foreign key instead of a convention.
--
-- The primary key is added by a following ALTER rather than inside CREATE TABLE, for
-- a reason that only shows up in the failing-insert tests. `(workspace_id, id)` is a
-- *subset* of the semantic key, so every row that breaks the semantic key also breaks
-- the primary key. PostgreSQL checks indexes in OID order and reports the first one
-- that fires, so whichever index is younger can never be named by an error. Creating
-- the semantic key first makes both demonstrable: a duplicate at the same firm names
-- the semantic key, and a duplicate id at a *different* firm breaks only the primary
-- key and names that. See docs/decisions/g3a-semantic-key-index-order.md.
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  full_name text NOT NULL,
  title text,
  linkedin_url text,
  status text NOT NULL DEFAULT 'active',
  is_primary boolean NOT NULL DEFAULT false,
  merged_into_contact_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The semantic composite key of section 7.2.
  CONSTRAINT contacts_semantic_key UNIQUE (workspace_id, id, firm_id),
  CONSTRAINT contacts_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT contacts_merged_into_fkey FOREIGN KEY (workspace_id, merged_into_contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id),
  CONSTRAINT contacts_full_name_present CHECK (btrim(full_name) <> '' AND length(full_name) <= 200),
  CONSTRAINT contacts_title_bounded CHECK (title IS NULL OR (btrim(title) <> '' AND length(title) <= 200)),
  CONSTRAINT contacts_linkedin_url_shape
    CHECK (linkedin_url IS NULL
           OR (linkedin_url ~ '^https://([a-z]{2,3}\.)?linkedin\.com/[^[:space:]]+$'
               AND length(linkedin_url) <= 400)),
  CONSTRAINT contacts_status_known CHECK (status IN ('active', 'inactive', 'merged')),
  CONSTRAINT contacts_merge_consistent CHECK ((status = 'merged') = (merged_into_contact_id IS NOT NULL)),
  CONSTRAINT contacts_not_merged_into_self
    CHECK (merged_into_contact_id IS NULL OR merged_into_contact_id <> id),
  -- A merged contact is never anybody's primary.
  CONSTRAINT contacts_merged_is_not_primary CHECK (status <> 'merged' OR is_primary = false),
  CONSTRAINT contacts_updated_not_before_created CHECK (updated_at >= created_at)
);

ALTER TABLE contacts ADD CONSTRAINT contacts_pkey PRIMARY KEY (workspace_id, id);

CREATE UNIQUE INDEX contacts_one_active_primary
  ON contacts (workspace_id, firm_id)
  WHERE is_primary AND status = 'active';

CREATE INDEX contacts_by_firm ON contacts (workspace_id, firm_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- phone_routes and email_addresses (specification 7.2, 9.1, 7.4)
--
-- "contact- or firm-level routes with canonical value, source, retrieval time,
-- association confidence, technical validation, and eligibility candidate | usable |
-- invalid | retired."
--
-- `contact_id` is nullable with a MATCH SIMPLE composite foreign key onto the
-- semantic key above: a firm-level route (a receptionist's number) skips the check,
-- and a contact-level one cannot name a contact at a different firm.
--
-- `version` is the number section 9.1 says the card displays and `authorizeDial`
-- compares, "preventing a stale client from dialing a replaced or retired number". It
-- only ever increases, and the trigger below enforces that rather than trusting a
-- caller to remember.
--
-- Section 7.4: a route becomes `usable` only when "a versioned provider/source policy
-- satisfies both technical-validation and association-confidence thresholds". The
-- thresholds themselves are the versioned policy in @fss/domain; what the database
-- refuses is a usable route with no passed validation, no confidence, or no policy
-- version recorded — a usable route that cannot say why.
--
-- The same handle at several firms stays several rows (7.2): uniqueness is per
-- association, not per value.
-- ---------------------------------------------------------------------------
CREATE TABLE phone_routes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  e164 text NOT NULL,
  source text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  association_confidence numeric(4, 3),
  technical_validation text NOT NULL DEFAULT 'unknown',
  eligibility text NOT NULL DEFAULT 'candidate',
  eligibility_policy_version text,
  version integer NOT NULL DEFAULT 1,
  retired_at timestamptz,
  retired_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phone_routes_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT phone_routes_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT phone_routes_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id),
  -- NULLS NOT DISTINCT: two firm-level rows with the same number at one firm collide,
  -- which is the point; PostgreSQL 15 and later treat the two NULLs as equal here.
  CONSTRAINT phone_routes_one_per_association
    UNIQUE NULLS NOT DISTINCT (workspace_id, firm_id, contact_id, e164),
  CONSTRAINT phone_routes_e164_shape CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT phone_routes_source_known
    CHECK (source IN ('research_provider', 'salesperson', 'import', 'website', 'reply')),
  CONSTRAINT phone_routes_confidence_range
    CHECK (association_confidence IS NULL OR (association_confidence >= 0 AND association_confidence <= 1)),
  CONSTRAINT phone_routes_technical_validation_known
    CHECK (technical_validation IN ('unknown', 'passed', 'failed')),
  CONSTRAINT phone_routes_eligibility_known
    CHECK (eligibility IN ('candidate', 'usable', 'invalid', 'retired')),
  CONSTRAINT phone_routes_usable_is_evidenced
    CHECK (eligibility <> 'usable'
           OR (technical_validation = 'passed'
               AND association_confidence IS NOT NULL
               AND eligibility_policy_version IS NOT NULL)),
  CONSTRAINT phone_routes_policy_version_shape
    CHECK (eligibility_policy_version IS NULL OR eligibility_policy_version ~ '^[a-z0-9._-]{1,40}$'),
  CONSTRAINT phone_routes_retirement_consistent CHECK ((eligibility = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT phone_routes_retired_reason_bounded
    CHECK (retired_reason IS NULL OR (btrim(retired_reason) <> '' AND length(retired_reason) <= 200)),
  CONSTRAINT phone_routes_version_positive CHECK (version >= 1),
  CONSTRAINT phone_routes_updated_not_before_created CHECK (updated_at >= created_at)
);

CREATE INDEX phone_routes_usable_by_firm
  ON phone_routes (workspace_id, firm_id)
  WHERE eligibility = 'usable';

CREATE TABLE email_addresses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  address text NOT NULL,
  source text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  association_confidence numeric(4, 3),
  technical_validation text NOT NULL DEFAULT 'unknown',
  eligibility text NOT NULL DEFAULT 'candidate',
  eligibility_policy_version text,
  version integer NOT NULL DEFAULT 1,
  retired_at timestamptz,
  retired_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_addresses_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT email_addresses_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT email_addresses_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id),
  CONSTRAINT email_addresses_one_per_association
    UNIQUE NULLS NOT DISTINCT (workspace_id, firm_id, contact_id, address),
  -- Canonical means lower-cased here, the same spelling the suppression canonicalizer
  -- produces, so a handle suppression and a route compare without a second rule.
  CONSTRAINT email_addresses_address_shape
    CHECK (address = lower(address)
           AND address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
           AND length(address) <= 320),
  CONSTRAINT email_addresses_source_known
    CHECK (source IN ('research_provider', 'salesperson', 'import', 'website', 'reply')),
  CONSTRAINT email_addresses_confidence_range
    CHECK (association_confidence IS NULL OR (association_confidence >= 0 AND association_confidence <= 1)),
  CONSTRAINT email_addresses_technical_validation_known
    CHECK (technical_validation IN ('unknown', 'passed', 'failed')),
  CONSTRAINT email_addresses_eligibility_known
    CHECK (eligibility IN ('candidate', 'usable', 'invalid', 'retired')),
  CONSTRAINT email_addresses_usable_is_evidenced
    CHECK (eligibility <> 'usable'
           OR (technical_validation = 'passed'
               AND association_confidence IS NOT NULL
               AND eligibility_policy_version IS NOT NULL)),
  CONSTRAINT email_addresses_policy_version_shape
    CHECK (eligibility_policy_version IS NULL OR eligibility_policy_version ~ '^[a-z0-9._-]{1,40}$'),
  CONSTRAINT email_addresses_retirement_consistent CHECK ((eligibility = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT email_addresses_retired_reason_bounded
    CHECK (retired_reason IS NULL OR (btrim(retired_reason) <> '' AND length(retired_reason) <= 200)),
  CONSTRAINT email_addresses_version_positive CHECK (version >= 1),
  CONSTRAINT email_addresses_updated_not_before_created CHECK (updated_at >= created_at)
);

CREATE INDEX email_addresses_by_address ON email_addresses (workspace_id, address);

-- A route version only ever increases (9.1: authorization uses the version the card
-- displayed). A caller that forgets to bump it on a change cannot silently reuse it,
-- and a caller that tries to lower it is refused.
CREATE FUNCTION assert_route_version_increases() RETURNS trigger
LANGUAGE plpgsql AS $route_version$
BEGIN
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'a route version never decreases (% to %)', OLD.version, NEW.version
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version = OLD.version
     AND (NEW.eligibility <> OLD.eligibility OR NEW.technical_validation <> OLD.technical_validation) THEN
    RAISE EXCEPTION 'a route whose eligibility changes bumps its version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$route_version$;

CREATE TRIGGER phone_routes_version_increases
  BEFORE UPDATE ON phone_routes
  FOR EACH ROW EXECUTE FUNCTION assert_route_version_increases();

CREATE TRIGGER email_addresses_version_increases
  BEFORE UPDATE ON email_addresses
  FOR EACH ROW EXECUTE FUNCTION assert_route_version_increases();

-- ---------------------------------------------------------------------------
-- evidence_items (specification 7.2, 7.4, 10.3)
--
-- "provider, source reference, retrieval time, confidence, terms/retention metadata,
-- and content hash." Any confidence may be retained as evidence when provider terms
-- allow, which is why `confidence` is free inside [0,1] and nothing here gates on it:
-- the gate is on the *route*, not on the evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  provider text NOT NULL,
  source_reference text NOT NULL,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  confidence numeric(4, 3),
  terms_allow_retention boolean NOT NULL DEFAULT true,
  retention_expires_at timestamptz,
  content_hash text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_items_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT evidence_items_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT evidence_items_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id),
  -- Appendix C: "provider result/evidence uniqueness". One provider result per firm.
  CONSTRAINT evidence_items_one_per_result UNIQUE (workspace_id, firm_id, provider, content_hash),
  CONSTRAINT evidence_items_provider_shape CHECK (provider ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT evidence_items_source_reference_present
    CHECK (btrim(source_reference) <> '' AND length(source_reference) <= 500),
  CONSTRAINT evidence_items_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT evidence_items_content_hash_shape CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  -- Section 10.3: research evidence is kept "with the firm while provider terms
  -- permit", so evidence whose terms forbid retention must carry its expiry.
  CONSTRAINT evidence_items_retention_consistent
    CHECK (terms_allow_retention OR retention_expires_at IS NOT NULL),
  CONSTRAINT evidence_items_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX evidence_items_by_firm ON evidence_items (workspace_id, firm_id, retrieved_at DESC);

-- ---------------------------------------------------------------------------
-- pipeline_stages (specification 7.2, 8.1)
--
-- "ordered configurable rows; default New, Contacting, Engaged, Qualified, Proposal,
-- Won, and Lost. Retired stages remain readable." Won and Lost are terminal, and a
-- terminal stage may be neither retired nor re-pointed: closing an opportunity has to
-- have somewhere to go.
--
-- The position constraint is DEFERRABLE INITIALLY IMMEDIATE so that a reorder can
-- `SET CONSTRAINTS pipeline_stages_position_unique DEFERRED` inside one transaction
-- and shuffle rows through each other's positions, while an ordinary duplicate is
-- still refused by the statement that caused it.
-- ---------------------------------------------------------------------------
CREATE TABLE pipeline_stages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  key text NOT NULL,
  display_name text NOT NULL,
  position integer NOT NULL,
  terminal_kind text,
  retired boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stages_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT pipeline_stages_key_unique UNIQUE (workspace_id, key),
  CONSTRAINT pipeline_stages_position_unique UNIQUE (workspace_id, position) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT pipeline_stages_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT pipeline_stages_display_name_present
    CHECK (btrim(display_name) <> '' AND length(display_name) <= 80),
  CONSTRAINT pipeline_stages_position_positive CHECK (position >= 1),
  CONSTRAINT pipeline_stages_terminal_kind_known CHECK (terminal_kind IS NULL OR terminal_kind IN ('won', 'lost')),
  -- "Admins may rename, reorder, add, or retire nonterminal stages": a terminal stage
  -- is never retired, because an opportunity must always have a Won and a Lost.
  CONSTRAINT pipeline_stages_terminal_not_retired CHECK (terminal_kind IS NULL OR retired = false),
  CONSTRAINT pipeline_stages_updated_not_before_created CHECK (updated_at >= created_at)
);

-- One Won and one Lost per workspace, so "closing an opportunity" is never ambiguous.
CREATE UNIQUE INDEX pipeline_stages_one_per_terminal_kind
  ON pipeline_stages (workspace_id, terminal_kind)
  WHERE terminal_kind IS NOT NULL;

-- The default pipeline of section 8.1, as a function so that the trigger below and
-- the backfill further down cannot drift apart.
CREATE FUNCTION seed_default_pipeline_stages(target_workspace uuid, seeded_at timestamptz) RETURNS void
LANGUAGE sql AS $stages$
  INSERT INTO pipeline_stages (workspace_id, key, display_name, position, terminal_kind, created_at, updated_at)
  VALUES
    (target_workspace, 'new',        'New',        1, NULL,   seeded_at, seeded_at),
    (target_workspace, 'contacting', 'Contacting', 2, NULL,   seeded_at, seeded_at),
    (target_workspace, 'engaged',    'Engaged',    3, NULL,   seeded_at, seeded_at),
    (target_workspace, 'qualified',  'Qualified',  4, NULL,   seeded_at, seeded_at),
    (target_workspace, 'proposal',   'Proposal',   5, NULL,   seeded_at, seeded_at),
    (target_workspace, 'won',        'Won',        6, 'won',  seeded_at, seeded_at),
    (target_workspace, 'lost',       'Lost',       7, 'lost', seeded_at, seeded_at)
  ON CONFLICT ON CONSTRAINT pipeline_stages_key_unique DO NOTHING;
$stages$;

CREATE FUNCTION seed_pipeline_for_new_workspace() RETURNS trigger
LANGUAGE plpgsql AS $new_workspace$
BEGIN
  PERFORM seed_default_pipeline_stages(NEW.id, NEW.created_at);
  RETURN NULL;
END;
$new_workspace$;

-- A workspace without a pipeline is a workspace no opportunity can exist in, so the
-- seeding is the database's job rather than the first command's.
CREATE TRIGGER workspaces_seed_pipeline
  AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION seed_pipeline_for_new_workspace();

-- Migrate, not expand: workspaces that already existed at version 3 get the same
-- seven rows, at a named constant instant rather than now().
SELECT seed_default_pipeline_stages(w.id, TIMESTAMPTZ '2026-09-20 00:00:00+00') FROM workspaces w;

-- ---------------------------------------------------------------------------
-- opportunities (specification 7.2, 7.3, 8.1)
--
-- "at most one open opportunity per firm; control_mode, mode-change time, and
-- reason." The first is a partial unique index over open rows, so a firm may have any
-- number of closed opportunities and exactly one open one.
--
-- `control_mode` is `automated | manual` and nothing else. Section 4.3: "Reversible
-- blockers are rows in `active_holds`, not a third mutually exclusive mode." There is
-- deliberately no `held` value here, and there never will be.
--
-- `opportunities_semantic_key` is section 7.2's second composite: stage events and,
-- later, enrollments reference `(workspace_id, id, firm_id)`.
-- ---------------------------------------------------------------------------
CREATE TABLE opportunities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open',
  control_mode text NOT NULL DEFAULT 'automated',
  control_mode_changed_at timestamptz NOT NULL,
  control_mode_reason text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_reason text,
  reopened_from_opportunity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunities_semantic_key UNIQUE (workspace_id, id, firm_id),
  CONSTRAINT opportunities_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT opportunities_stage_fkey FOREIGN KEY (workspace_id, stage_id)
    REFERENCES pipeline_stages (workspace_id, id),
  CONSTRAINT opportunities_reopened_from_fkey FOREIGN KEY (workspace_id, reopened_from_opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id),
  CONSTRAINT opportunities_status_known CHECK (status IN ('open', 'won', 'lost')),
  CONSTRAINT opportunities_control_mode_known CHECK (control_mode IN ('automated', 'manual')),
  -- Manual mode always says what made it manual (7.3): a confirmed reply, a call
  -- outcome, a direct Gmail send, a reopen.
  --
  -- `IS NOT NULL` is written out rather than left to `btrim(NULL) <> ''`, which is
  -- NULL, which a CHECK treats as satisfied. That is exactly how a Lost opportunity
  -- with no reason would have slipped through.
  CONSTRAINT opportunities_manual_has_reason
    CHECK (control_mode = 'automated'
           OR (control_mode_reason IS NOT NULL
               AND btrim(control_mode_reason) <> ''
               AND length(control_mode_reason) <= 300)),
  CONSTRAINT opportunities_close_consistent CHECK ((status = 'open') = (closed_at IS NULL)),
  -- Section 8.1: "Lost changes require a reason."
  CONSTRAINT opportunities_lost_needs_reason
    CHECK (status <> 'lost'
           OR (close_reason IS NOT NULL AND btrim(close_reason) <> '' AND length(close_reason) <= 500)),
  CONSTRAINT opportunities_close_reason_bounded
    CHECK (close_reason IS NULL OR (btrim(close_reason) <> '' AND length(close_reason) <= 500)),
  CONSTRAINT opportunities_close_not_before_open CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT opportunities_not_reopened_from_self
    CHECK (reopened_from_opportunity_id IS NULL OR reopened_from_opportunity_id <> id),
  CONSTRAINT opportunities_updated_not_before_created CHECK (updated_at >= created_at)
);

-- The semantic key first, then the primary key: see the note on `contacts` above.
ALTER TABLE opportunities ADD CONSTRAINT opportunities_pkey PRIMARY KEY (workspace_id, id);

CREATE UNIQUE INDEX opportunities_one_open_per_firm
  ON opportunities (workspace_id, firm_id)
  WHERE status = 'open';

CREATE INDEX opportunities_by_stage ON opportunities (workspace_id, stage_id) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- opportunity_stage_events (specification 7.2, 8.1) — append-only
--
-- "Every stage change creates an append-only event in the same transaction." The
-- composite foreign key is onto the opportunity's semantic key, so an event cannot
-- name an opportunity at one firm and a firm at another.
-- ---------------------------------------------------------------------------
CREATE TABLE opportunity_stage_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  from_stage_id uuid,
  to_stage_id uuid NOT NULL,
  actor_kind text NOT NULL,
  actor_user_id uuid,
  reason text,
  command_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_stage_events_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT opportunity_stage_events_opportunity_fkey
    FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id),
  CONSTRAINT opportunity_stage_events_from_stage_fkey FOREIGN KEY (workspace_id, from_stage_id)
    REFERENCES pipeline_stages (workspace_id, id),
  CONSTRAINT opportunity_stage_events_to_stage_fkey FOREIGN KEY (workspace_id, to_stage_id)
    REFERENCES pipeline_stages (workspace_id, id),
  CONSTRAINT opportunity_stage_events_actor_kind_known
    CHECK (actor_kind IN ('user', 'admin', 'system', 'worker')),
  CONSTRAINT opportunity_stage_events_user_actor_identified
    CHECK ((actor_kind IN ('user', 'admin')) = (actor_user_id IS NOT NULL)),
  CONSTRAINT opportunity_stage_events_reason_bounded
    CHECK (reason IS NULL OR (btrim(reason) <> '' AND length(reason) <= 500)),
  CONSTRAINT opportunity_stage_events_command_id_shape
    CHECK (command_id IS NULL OR command_id ~ '^[0-9a-zA-Z_:-]{1,128}$'),
  CONSTRAINT opportunity_stage_events_moves CHECK (from_stage_id IS NULL OR from_stage_id <> to_stage_id)
);

CREATE INDEX opportunity_stage_events_by_opportunity
  ON opportunity_stage_events (workspace_id, opportunity_id, occurred_at);

-- ---------------------------------------------------------------------------
-- record_aliases (specification 7.2: merges "preserve ... aliases ... and external
-- IDs")
--
-- One table for both kinds of record, because an alias is the same thing either way:
-- a spelling or an identifier that used to reach this record and must keep reaching
-- it after a merge. `firm_id` is always present, so a contact alias is scoped by the
-- semantic composite key like every other child of a contact.
-- ---------------------------------------------------------------------------
CREATE TABLE record_aliases (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  record_kind text NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  alias_kind text NOT NULL,
  alias_value text NOT NULL,
  source_record_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT record_aliases_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT record_aliases_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT record_aliases_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id),
  CONSTRAINT record_aliases_unique
    UNIQUE NULLS NOT DISTINCT (workspace_id, firm_id, contact_id, alias_kind, alias_value),
  CONSTRAINT record_aliases_record_kind_known CHECK (record_kind IN ('firm', 'contact')),
  CONSTRAINT record_aliases_contact_consistent CHECK ((record_kind = 'contact') = (contact_id IS NOT NULL)),
  CONSTRAINT record_aliases_alias_kind_known
    CHECK (alias_kind IN ('name', 'external_id', 'domain', 'email', 'phone')),
  CONSTRAINT record_aliases_alias_value_present
    CHECK (btrim(alias_value) <> '' AND length(alias_value) <= 320)
);

-- ---------------------------------------------------------------------------
-- record_merge_events (specification 7.2) — append-only
--
-- "append-only source/target mapping and preserved identifiers." A source record is
-- merged once and never again, which is the unique key below; `preserved` records
-- what moved, so a later audit does not have to reconstruct it from row counts.
-- ---------------------------------------------------------------------------
CREATE TABLE record_merge_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  record_kind text NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  performed_by_user_id uuid,
  command_id text,
  preserved jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT record_merge_events_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT record_merge_events_one_per_source UNIQUE (workspace_id, record_kind, source_id),
  CONSTRAINT record_merge_events_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT record_merge_events_actor_fkey FOREIGN KEY (workspace_id, performed_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT record_merge_events_record_kind_known CHECK (record_kind IN ('firm', 'contact')),
  CONSTRAINT record_merge_events_distinct CHECK (source_id <> target_id),
  CONSTRAINT record_merge_events_command_id_shape
    CHECK (command_id IS NULL OR command_id ~ '^[0-9a-zA-Z_:-]{1,128}$'),
  CONSTRAINT record_merge_events_preserved_is_object CHECK (jsonb_typeof(preserved) = 'object')
);

-- ---------------------------------------------------------------------------
-- crm_domain_events (specification 7.3, 8.1, Appendix A) — append-only
--
-- The hook the later lanes subscribe to, and the reason this lane can honour
-- "terminal stops hooked for G8" and Appendix A's "Today transfer" without owning
-- either.
--
-- A row is written in the *same transaction* as the business change that caused it,
-- so a subscriber that has seen the row has seen a committed fact, and a transaction
-- that rolled back left no signal. `dedupe_key` is what makes a subscriber's at-least
-- -once read safe: one signal per (kind, key), enforced by a unique constraint rather
-- than by the subscriber remembering.
--
-- This is deliberately not a `jobs` row. The job kinds of Appendix C are a closed set
-- owned by the queue, the subscribers do not exist yet, and a job that no handler is
-- registered for would become a dead job and an alert. See
-- docs/decisions/g3a-domain-event-outbox.md.
-- ---------------------------------------------------------------------------
CREATE TABLE crm_domain_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  event_kind text NOT NULL,
  firm_id uuid NOT NULL,
  opportunity_id uuid,
  contact_id uuid,
  dedupe_key text NOT NULL,
  reason_code text REFERENCES hold_reason_codes (code),
  actor_kind text NOT NULL,
  actor_user_id uuid,
  command_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_domain_events_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT crm_domain_events_dedupe UNIQUE (workspace_id, event_kind, dedupe_key),
  CONSTRAINT crm_domain_events_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT crm_domain_events_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id),
  CONSTRAINT crm_domain_events_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id),
  CONSTRAINT crm_domain_events_kind_known
    CHECK (event_kind IN ('opportunity.terminal_stop', 'opportunity.manual_mode', 'opportunity.reopened',
                          'firm.reassigned', 'firm.merged', 'contact.merged', 'route.retired')),
  CONSTRAINT crm_domain_events_dedupe_key_present
    CHECK (btrim(dedupe_key) <> '' AND length(dedupe_key) <= 200),
  CONSTRAINT crm_domain_events_actor_kind_known CHECK (actor_kind IN ('user', 'admin', 'system', 'worker')),
  CONSTRAINT crm_domain_events_user_actor_identified
    CHECK ((actor_kind IN ('user', 'admin')) = (actor_user_id IS NOT NULL)),
  CONSTRAINT crm_domain_events_command_id_shape
    CHECK (command_id IS NULL OR command_id ~ '^[0-9a-zA-Z_:-]{1,128}$'),
  -- An opportunity event names its opportunity; a firm or contact event does not.
  CONSTRAINT crm_domain_events_opportunity_present
    CHECK ((event_kind LIKE 'opportunity.%') = (opportunity_id IS NOT NULL)),
  CONSTRAINT crm_domain_events_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX crm_domain_events_by_kind ON crm_domain_events (workspace_id, event_kind, occurred_at);

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then, so every table above needs its own grant, and the three history tables need
-- their own REVOKE. See docs/greenfield/migrations.md, step 5.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON firms TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON phone_routes TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_addresses TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON evidence_items TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_stages TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON opportunities TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON record_aliases TO app_runtime, migration;

GRANT SELECT, INSERT ON opportunity_stage_events TO app_runtime, migration;
GRANT SELECT, INSERT ON record_merge_events TO app_runtime, migration;
GRANT SELECT, INSERT ON crm_domain_events TO app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON opportunity_stage_events FROM app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON record_merge_events FROM app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON crm_domain_events FROM app_runtime, migration;
