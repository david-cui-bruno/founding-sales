-- 0001_foundation
--
-- The foundation tables of the greenfield Founding Sales System (specification
-- revision 3, 19 September 2026: sections 4.3, 5.1-5.3, 6, 7.1, 10.2, 13.2, 13.3,
-- 15 and Appendix E). Forward-only: this file never changes once it has been
-- applied anywhere. See docs/greenfield/migrations.md.
--
-- Two rules run through the whole file:
--   * every business table carries workspace_id, and every key a lookup may use
--     begins with it, so a bare id can never reach a row in another workspace;
--   * child tables reference parents by the composite (workspace_id, id), so a
--     foreign key cannot cross a workspace boundary even if an id is guessed.
--
-- Seeded rows carry a named constant instant rather than now(): a migration must
-- produce the same rows at 23:59 UTC as it does at 09:00.

-- ---------------------------------------------------------------------------
-- Roles
--
-- Roles are cluster-wide, and one cluster hosts one database per test file, so two
-- migrations may reach this block at the same moment. `IF NOT EXISTS` would be a
-- check-then-create race, and the loser's CREATE ROLE reports unique_violation on
-- pg_authid rather than duplicate_object. Both are caught, each inside its own
-- subtransaction, so the rest of the migration is untouched.
--
-- app_runtime is the application's role; migration is the role that applies this
-- file. Neither may UPDATE or DELETE an append-only table, and that is enforced by
-- privilege, not by convention.
-- ---------------------------------------------------------------------------
DO $roles$
BEGIN
  BEGIN
    CREATE ROLE app_runtime NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
  BEGIN
    CREATE ROLE migration NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
END
$roles$;

GRANT USAGE ON SCHEMA public TO app_runtime, migration;

-- ---------------------------------------------------------------------------
-- Reference data: the closed hold reason codes of specification section 15.
-- A reference table rather than a CHECK list, so active_holds and
-- administrative_pauses share one vocabulary and a test can compare the stored
-- set with the @fss/contracts enum row for row.
-- ---------------------------------------------------------------------------
CREATE TABLE hold_reason_codes (
  code text PRIMARY KEY,
  description text NOT NULL,
  -- Specification section 15: only explicitly recoverable holds expose controls.
  recoverable boolean NOT NULL,
  CONSTRAINT hold_reason_codes_code_shape CHECK (code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT hold_reason_codes_description_present CHECK (btrim(description) <> '')
);

INSERT INTO hold_reason_codes (code, description, recoverable) VALUES
  ('scoped_pause',             'An administrative pause covers this workspace, owner, opportunity or channel.', true),
  ('mailbox_disconnected',     'The owner''s Gmail grant is revoked or the mailbox is disconnected.', true),
  ('coverage_incomplete',      'The mailbox coverage watermark does not yet prove every relevant message processed.', true),
  ('template_unapproved',      'The step''s template version is not an approved immutable version.', true),
  ('missing_variables',        'A required template variable has no eligible value.', true),
  ('daily_cap',                'The mailbox''s automated daily cap for the workspace business date is reached.', true),
  ('domain_cap',               'The rolling primary-domain recipient guard is reached.', false),
  ('route_missing',            'No email or phone route exists for the contact.', true),
  ('route_candidate',          'The route exists but is only a candidate under the route-eligibility policy.', true),
  ('route_invalid',            'The route failed technical validation.', true),
  ('route_retired',            'The route was retired.', true),
  ('outside_email_window',     'The firm''s local time is outside the weekday email window.', true),
  ('outside_calling_window',   'The firm''s local time is outside the weekday calling window.', true),
  ('posture_missing',          'No state posture applies to the firm''s state at database time.', false),
  ('posture_overlapping',      'More than one state posture applies; the decision fails closed.', false),
  ('posture_overdue',          'The applicable state posture''s review date has passed.', false),
  ('firm_suppressed',          'An effective firm-wide do-not-contact suppression covers this firm.', false),
  ('handle_suppressed',        'An effective handle suppression covers this email address or number.', false),
  ('manual_suppression_review','A salesperson''s manual suppression is inside its ten-minute correction window.', false),
  ('uncertain_reply',          'An incoming message may be human; every automated action for the firm is blocked.', true),
  ('ambiguous_match',          'An incoming message plausibly matches more than one open opportunity.', true),
  ('reassignment',             'The firm is being reassigned; future work is cancelled or rebound.', true),
  ('opportunity_manual',       'The opportunity is in manual control mode.', false),
  ('provider_refusal',         'A research or mail provider refused the request.', true),
  ('send_unknown_reconciling', 'An outbound fence is reconciling against the Gmail Sent folder.', false),
  ('send_unknown_terminal',    'An outbound fence ended unknown; an admin must mark it delivered or skipped.', true),
  ('dead_job',                 'A job exhausted its attempts and awaits an audited admin requeue.', true),
  ('long_hold_review',         'The union of blocking intervals exceeded seven days; the salesperson must review and resume.', true),
  ('restore_in_progress',      'The post-restore protocol has not completed; sending and dialing stay held.', false);

-- ---------------------------------------------------------------------------
-- workspaces (specification 7.1 and Appendix D)
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text NOT NULL,
  -- Appendix D: the Today snapshot date and the daily caps count in this zone.
  business_time_zone text NOT NULL DEFAULT 'America/New_York',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_slug_unique UNIQUE (slug),
  CONSTRAINT workspaces_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  CONSTRAINT workspaces_display_name_present CHECK (btrim(display_name) <> '' AND length(display_name) <= 200),
  -- The IANA name is checked for shape here and for existence by @fss/domain, which
  -- can ask Intl. A catalogue lookup is not immutable, so it cannot be a CHECK.
  CONSTRAINT workspaces_business_time_zone_shape
    CHECK (business_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$'),
  CONSTRAINT workspaces_updated_not_before_created CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- users (specification 5.1)
--
-- Google `sub` is the durable identifier and is unique. Email is display data and
-- is deliberately NOT unique: two Callie people may share an alias, and a changed
-- primary address must never create a second account or collide with one.
-- Users are not workspace-scoped; membership is what grants access.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_google_sub_unique UNIQUE (google_sub),
  CONSTRAINT users_google_sub_present CHECK (btrim(google_sub) <> '' AND length(google_sub) <= 255),
  CONSTRAINT users_email_shape CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT users_display_name_present CHECK (btrim(display_name) <> '' AND length(display_name) <= 200)
);

-- ---------------------------------------------------------------------------
-- workspace_memberships (specification 5.1, 5.2)
-- ---------------------------------------------------------------------------
CREATE TABLE workspace_memberships (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  CONSTRAINT workspace_memberships_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_memberships_one_per_user UNIQUE (workspace_id, user_id),
  CONSTRAINT workspace_memberships_role_known CHECK (role IN ('admin', 'salesperson')),
  CONSTRAINT workspace_memberships_status_known CHECK (status IN ('active', 'inactive')),
  CONSTRAINT workspace_memberships_deactivation_consistent
    CHECK ((status = 'inactive') = (deactivated_at IS NOT NULL))
);

CREATE INDEX workspace_memberships_active_admins
  ON workspace_memberships (workspace_id)
  WHERE role = 'admin' AND status = 'active';

-- Specification 5.2: the last active admin cannot deactivate themselves or be removed.
CREATE FUNCTION assert_active_admin_remains() RETURNS trigger
LANGUAGE plpgsql AS $admin$
DECLARE
  remaining integer;
BEGIN
  IF OLD.role <> 'admin' OR OLD.status <> 'active' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'admin' AND NEW.status = 'active' AND NEW.workspace_id = OLD.workspace_id THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO remaining
    FROM workspace_memberships m
   WHERE m.workspace_id = OLD.workspace_id
     AND m.role = 'admin'
     AND m.status = 'active';
  IF remaining = 0 THEN
    RAISE EXCEPTION 'workspace % would be left without an active admin', OLD.workspace_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$admin$;

CREATE CONSTRAINT TRIGGER workspace_memberships_last_active_admin
  AFTER UPDATE OR DELETE ON workspace_memberships
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_active_admin_remains();

-- ---------------------------------------------------------------------------
-- devices (specification 5.3)
--
-- The device secret exists here only as a server-side hash. The plaintext lives in
-- the macOS Keychain and nowhere else, and this column's CHECK refuses anything
-- that is not a 64-character lowercase hex digest, so a plaintext secret written
-- here by mistake is rejected by the database.
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  device_label text NOT NULL,
  secret_hash text NOT NULL,
  -- The device-bound renewal credential rotates on every use; reuse of an older
  -- generation revokes the device (5.3). The number only ever increases.
  credential_generation bigint NOT NULL DEFAULT 1,
  client_version text,
  status text NOT NULL DEFAULT 'active',
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT devices_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT devices_membership_fkey FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT devices_label_present CHECK (btrim(device_label) <> '' AND length(device_label) <= 120),
  CONSTRAINT devices_secret_hash_shape CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT devices_credential_generation_positive CHECK (credential_generation >= 1),
  CONSTRAINT devices_status_known CHECK (status IN ('active', 'revoked')),
  CONSTRAINT devices_revocation_consistent CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT devices_client_version_shape
    CHECK (client_version IS NULL OR client_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$')
);

-- ---------------------------------------------------------------------------
-- calling_identities (specification 9.1, and the "shared resources" decision)
--
-- A null owner is the reserved future shared line. Such a row may exist but can
-- never be enabled, which is the check authorizeDial will read.
-- ---------------------------------------------------------------------------
CREATE TABLE calling_identities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  owner_user_id uuid,
  e164 text NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified',
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calling_identities_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT calling_identities_number_unique UNIQUE (workspace_id, e164),
  -- MATCH SIMPLE: a null owner skips the check entirely, which is what reserves
  -- the shared line without pointing it at a membership that does not exist.
  CONSTRAINT calling_identities_owner_fkey FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT calling_identities_e164_shape CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT calling_identities_verification_known
    CHECK (verification_status IN ('unverified', 'verified')),
  CONSTRAINT calling_identities_shared_line_disabled
    CHECK (owner_user_id IS NOT NULL OR enabled = false),
  CONSTRAINT calling_identities_enabled_requires_verification
    CHECK (enabled = false OR verification_status = 'verified')
);

-- ---------------------------------------------------------------------------
-- command_receipts (specification 5.3, Appendix A)
--
-- Same id and payload returns the original result; a different payload or device
-- is rejected. The uniqueness is the primary key, so the check cannot be skipped.
-- ---------------------------------------------------------------------------
CREATE TABLE command_receipts (
  workspace_id uuid NOT NULL,
  device_id uuid NOT NULL,
  command_id text NOT NULL,
  command_kind text NOT NULL,
  payload_hash text NOT NULL,
  result_status text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT command_receipts_pkey PRIMARY KEY (workspace_id, device_id, command_id),
  CONSTRAINT command_receipts_device_fkey FOREIGN KEY (workspace_id, device_id)
    REFERENCES devices (workspace_id, id),
  CONSTRAINT command_receipts_command_id_shape
    CHECK (command_id ~ '^[0-9a-zA-Z_:-]{1,128}$'),
  CONSTRAINT command_receipts_kind_present CHECK (btrim(command_kind) <> '' AND length(command_kind) <= 80),
  CONSTRAINT command_receipts_payload_hash_shape CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT command_receipts_result_status_known
    CHECK (result_status IN ('accepted', 'refused')),
  -- A dial authorization replay never returns an actionable result (5.3), so a
  -- receipt for one carries no result body at all.
  CONSTRAINT command_receipts_dial_result_not_actionable
    CHECK (command_kind <> 'authorize_dial' OR result IS NULL)
);

-- ---------------------------------------------------------------------------
-- audit_events (specification 5.2, 10.3) — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL,
  actor_user_id uuid REFERENCES users (id),
  action text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_events_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT audit_events_actor_kind_known
    CHECK (actor_kind IN ('user', 'admin', 'system', 'worker')),
  CONSTRAINT audit_events_user_actor_identified
    CHECK ((actor_kind IN ('user', 'admin')) = (actor_user_id IS NOT NULL)),
  CONSTRAINT audit_events_action_present CHECK (btrim(action) <> '' AND length(action) <= 120),
  CONSTRAINT audit_events_subject_kind_present CHECK (btrim(subject_kind) <> '' AND length(subject_kind) <= 80),
  CONSTRAINT audit_events_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX audit_events_by_workspace_time ON audit_events (workspace_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- suppression_events (specification 10.2) — insert-only
--
-- The full protocol (effective view, ten-minute correction, finalizer, admin
-- supersession) belongs to a later slice. What this file fixes is the shape that
-- protocol needs and the privilege that makes "insert-only" true.
-- ---------------------------------------------------------------------------
CREATE TABLE suppression_events (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  event_id text NOT NULL,
  scope text NOT NULL,
  canonical_key text NOT NULL,
  canonicalizer_version text NOT NULL,
  source text NOT NULL,
  actor_user_id uuid REFERENCES users (id),
  command_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  supersedes_event_id text,
  supersession_reason text,
  CONSTRAINT suppression_events_pkey PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT suppression_events_scope_known CHECK (scope IN ('firm', 'handle')),
  CONSTRAINT suppression_events_canonical_key_present
    CHECK (btrim(canonical_key) <> '' AND canonical_key = lower(canonical_key) AND length(canonical_key) <= 320),
  CONSTRAINT suppression_events_canonicalizer_version_shape
    CHECK (canonicalizer_version ~ '^[a-z0-9._-]{1,40}$'),
  CONSTRAINT suppression_events_source_known
    CHECK (source IN ('prospect_opt_out', 'prospect_do_not_call', 'salesperson_manual', 'import',
                      'mistaken_entry_correction', 'admin_supersession')),
  CONSTRAINT suppression_events_supersession_consistent
    CHECK ((source IN ('mistaken_entry_correction', 'admin_supersession')) = (supersedes_event_id IS NOT NULL)),
  CONSTRAINT suppression_events_supersession_reason_known
    CHECK (supersession_reason IS NULL OR supersession_reason IN ('mistaken_entry', 'correction', 'documented_reconsent')),
  CONSTRAINT suppression_events_supersession_reason_required
    CHECK ((supersedes_event_id IS NULL) = (supersession_reason IS NULL)),
  CONSTRAINT suppression_events_superseded_fkey FOREIGN KEY (workspace_id, supersedes_event_id)
    REFERENCES suppression_events (workspace_id, event_id)
);

-- 10.2: at most one direct supersession may reference an event.
CREATE UNIQUE INDEX suppression_events_one_direct_supersession
  ON suppression_events (workspace_id, supersedes_event_id)
  WHERE supersedes_event_id IS NOT NULL;

CREATE INDEX suppression_events_by_key
  ON suppression_events (workspace_id, scope, canonical_key, recorded_at);

-- ---------------------------------------------------------------------------
-- active_holds (specification 4.3, 15)
--
-- A hold is a record, never a third control mode. Clearing one hold never clears
-- another; the schedule shift is the union of the blocking intervals.
-- ---------------------------------------------------------------------------
CREATE TABLE active_holds (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  scope_kind text NOT NULL,
  scope_key text,
  reason_code text NOT NULL REFERENCES hold_reason_codes (code),
  blocked_action_kinds text[] NOT NULL,
  source_event_kind text NOT NULL,
  source_event_id text,
  owner_user_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  recovery_action text,
  CONSTRAINT active_holds_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT active_holds_scope_kind_known
    CHECK (scope_kind IN ('workspace', 'owner', 'mailbox', 'firm', 'opportunity', 'enrollment', 'channel')),
  CONSTRAINT active_holds_workspace_scope_has_no_key
    CHECK ((scope_kind = 'workspace') = (scope_key IS NULL)),
  CONSTRAINT active_holds_blocked_action_kinds_known
    CHECK (cardinality(blocked_action_kinds) > 0
           AND blocked_action_kinds <@ ARRAY['email_send', 'call_task', 'linkedin_task',
                                             'dial_authorization', 'enrollment_advance', 'research']::text[]),
  CONSTRAINT active_holds_source_event_kind_present
    CHECK (btrim(source_event_kind) <> '' AND length(source_event_kind) <= 80),
  CONSTRAINT active_holds_release_not_before_start
    CHECK (released_at IS NULL OR released_at >= started_at),
  CONSTRAINT active_holds_recovery_action_known
    CHECK (recovery_action IS NULL
           OR recovery_action IN ('resume_after_review', 'reconnect_mailbox', 'confirm_reply',
                                  'resolve_ambiguity', 'release_pause', 'mark_delivered_or_skipped',
                                  'requeue_job', 'advance_generation'))
);

CREATE INDEX active_holds_open_by_scope
  ON active_holds (workspace_id, scope_kind, scope_key)
  WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- administrative_pauses (specification 10.1)
--
-- Every pause creates an active hold; the pause row carries the history and the
-- hold carries the block. A pause is never a suppression and never terminal.
-- ---------------------------------------------------------------------------
CREATE TABLE administrative_pauses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  scope_kind text NOT NULL,
  scope_key text,
  channel text,
  reason_code text NOT NULL REFERENCES hold_reason_codes (code),
  reason_note text,
  hold_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_by_user_id uuid,
  released_at timestamptz,
  CONSTRAINT administrative_pauses_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT administrative_pauses_hold_fkey FOREIGN KEY (workspace_id, hold_id)
    REFERENCES active_holds (workspace_id, id),
  CONSTRAINT administrative_pauses_creator_fkey FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT administrative_pauses_releaser_fkey FOREIGN KEY (workspace_id, released_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT administrative_pauses_scope_kind_known
    CHECK (scope_kind IN ('workspace', 'owner', 'mailbox', 'opportunity', 'channel', 'all_automation')),
  CONSTRAINT administrative_pauses_scope_key_required
    CHECK ((scope_kind IN ('workspace', 'all_automation')) = (scope_key IS NULL)),
  CONSTRAINT administrative_pauses_channel_known
    CHECK (channel IS NULL OR channel IN ('email', 'call', 'linkedin', 'research')),
  CONSTRAINT administrative_pauses_channel_scope_consistent
    CHECK ((scope_kind = 'channel') = (channel IS NOT NULL)),
  CONSTRAINT administrative_pauses_reason_note_bounded
    CHECK (reason_note IS NULL OR (btrim(reason_note) <> '' AND length(reason_note) <= 500)),
  CONSTRAINT administrative_pauses_release_consistent
    CHECK ((released_at IS NULL) = (released_by_user_id IS NULL)),
  CONSTRAINT administrative_pauses_release_not_before_create
    CHECK (released_at IS NULL OR released_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- system_generations (Appendix E)
--
-- Database-level, not workspace-level: a restore replaces the whole database, and
-- the generation is what tells a service that it is looking at restored data.
-- The operator-controlled expected generation is configuration; this table is
-- what the database itself reports.
-- ---------------------------------------------------------------------------
CREATE TABLE system_generations (
  generation bigint PRIMARY KEY,
  reason text NOT NULL,
  established_at timestamptz NOT NULL,
  established_by_user_id uuid REFERENCES users (id),
  notes text,
  CONSTRAINT system_generations_generation_positive CHECK (generation >= 1),
  CONSTRAINT system_generations_reason_known
    CHECK (reason IN ('initial', 'restore_completed', 'operator_advance')),
  CONSTRAINT system_generations_operator_advance_attributed
    CHECK (reason = 'initial' OR established_by_user_id IS NOT NULL),
  CONSTRAINT system_generations_notes_bounded
    CHECK (notes IS NULL OR (btrim(notes) <> '' AND length(notes) <= 1000))
);

-- A named constant instant, not now(): a migration produces the same row whenever it runs.
INSERT INTO system_generations (generation, reason, established_at, established_by_user_id, notes)
VALUES (1, 'initial', TIMESTAMPTZ '2026-09-19 00:00:00+00', NULL, 'Foundation migration 0001.');

-- ---------------------------------------------------------------------------
-- retention_policies (specification 10.3)
-- ---------------------------------------------------------------------------
CREATE TABLE retention_policies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  data_kind text NOT NULL,
  retention_interval interval,
  disposition text NOT NULL,
  effective_from timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_policies_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT retention_policies_one_per_kind UNIQUE (workspace_id, data_kind),
  CONSTRAINT retention_policies_data_kind_known
    CHECK (data_kind IN ('business_records', 'suppression_history', 'audit_events', 'research_evidence',
                         'unmatched_gmail_metadata', 'raw_mime', 'matched_message_body', 'canceled_drafts',
                         'operational_logs', 'database_backups')),
  CONSTRAINT retention_policies_disposition_known
    CHECK (disposition IN ('delete', 'tombstone', 'retain_indefinitely', 'retain_with_business_record')),
  -- An indefinite retention names no interval; a bounded one must name a positive interval.
  CONSTRAINT retention_policies_interval_consistent
    CHECK ((disposition IN ('retain_indefinitely', 'retain_with_business_record')) = (retention_interval IS NULL)),
  CONSTRAINT retention_policies_interval_positive
    CHECK (retention_interval IS NULL OR retention_interval > INTERVAL '0')
);

-- ---------------------------------------------------------------------------
-- jobs (specification 13.2)
--
-- The claim code belongs to a later slice; this file fixes the columns, the
-- uniqueness that stops duplicate materialization, and the two partial indexes
-- the claim and the lease reaper read.
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  run_at timestamptz NOT NULL DEFAULT now(),
  not_before timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  lease_owner text,
  lease_expires_at timestamptz,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT jobs_idempotent UNIQUE (workspace_id, kind, idempotency_key),
  CONSTRAINT jobs_kind_shape CHECK (kind ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT jobs_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT jobs_idempotency_key_present
    CHECK (btrim(idempotency_key) <> '' AND length(idempotency_key) <= 200),
  CONSTRAINT jobs_state_known CHECK (state IN ('queued', 'running', 'retryable', 'done', 'dead')),
  CONSTRAINT jobs_attempts_sane CHECK (attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts),
  CONSTRAINT jobs_lease_consistent
    CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT jobs_lease_owner_bounded
    CHECK (lease_owner IS NULL OR (btrim(lease_owner) <> '' AND length(lease_owner) <= 120)),
  -- Bounded and redacted: the error detail is a short operator hint, never a body.
  CONSTRAINT jobs_error_detail_bounded CHECK (error_detail IS NULL OR length(error_detail) <= 2000)
);

-- Claims read this index with FOR UPDATE SKIP LOCKED.
CREATE INDEX jobs_runnable
  ON jobs (run_at, not_before, id)
  WHERE state IN ('queued', 'retryable');

-- Expired running leases are indexed separately (13.2).
CREATE INDEX jobs_expired_leases
  ON jobs (lease_expires_at)
  WHERE state = 'running';

-- ---------------------------------------------------------------------------
-- daily_counters (specification 13.3, Appendix D)
--
-- The business date is explicit, and the zone that produced it is stored beside it,
-- so a later change to the workspace business zone cannot silently re-date history.
-- ---------------------------------------------------------------------------
CREATE TABLE daily_counters (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  subject_kind text NOT NULL,
  subject_key text NOT NULL,
  counter_kind text NOT NULL,
  business_date date NOT NULL,
  business_time_zone text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_counters_pkey
    PRIMARY KEY (workspace_id, subject_kind, subject_key, counter_kind, business_date),
  CONSTRAINT daily_counters_subject_kind_known
    CHECK (subject_kind IN ('workspace', 'owner', 'mailbox', 'domain')),
  CONSTRAINT daily_counters_subject_key_present
    CHECK (btrim(subject_key) <> '' AND length(subject_key) <= 320),
  CONSTRAINT daily_counters_counter_kind_shape CHECK (counter_kind ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT daily_counters_count_nonnegative CHECK (count >= 0),
  CONSTRAINT daily_counters_business_time_zone_shape
    CHECK (business_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$')
);

-- ---------------------------------------------------------------------------
-- heartbeats (specification 13.3)
--
-- API, scheduler and worker heartbeats are database-level; a mailbox heartbeat is
-- always a workspace's. The pair of checks makes that difference explicit.
-- ---------------------------------------------------------------------------
CREATE TABLE heartbeats (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces (id),
  component text NOT NULL,
  instance_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT heartbeats_pkey PRIMARY KEY (id),
  CONSTRAINT heartbeats_identity UNIQUE NULLS NOT DISTINCT (component, instance_key, workspace_id),
  CONSTRAINT heartbeats_component_known CHECK (component IN ('api', 'scheduler', 'worker', 'mailbox')),
  CONSTRAINT heartbeats_mailbox_is_workspace_scoped
    CHECK ((component = 'mailbox') = (workspace_id IS NOT NULL)),
  CONSTRAINT heartbeats_instance_key_present
    CHECK (btrim(instance_key) <> '' AND length(instance_key) <= 200),
  CONSTRAINT heartbeats_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);

-- ---------------------------------------------------------------------------
-- Privileges
--
-- app_runtime reads and writes ordinary tables. audit_events and
-- suppression_events are append-only for both application and migration roles
-- (5.2, 10.2): they may INSERT and SELECT, never UPDATE, DELETE or TRUNCATE.
-- Reference data is read-only for both.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO migration;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON suppression_events FROM app_runtime, migration;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON hold_reason_codes FROM app_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON schema_versions FROM app_runtime;
