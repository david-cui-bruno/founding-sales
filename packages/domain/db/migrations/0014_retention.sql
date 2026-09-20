-- ---------------------------------------------------------------------------
-- 0014_retention.sql — retention, deletion and departure (specification 10.3,
-- Appendix C "Retention batch", Appendix F, Appendix G scenario 41)
--
-- Section 10.3 is a table of horizons and three sentences: a documented deletion
-- workflow, a departure protocol, and "attachments are not copied into FSS". This
-- migration adds only what those need that does not exist already:
--
--   * `retention_runs`  — the run ledger. Appendix C's third column for
--     `retention.batch` is "Deletion tombstone and bounded range", and
--     `UNIQUE(workspace_id, data_kind, period)` beside the boundary instant is
--     literally both of those: the row is the tombstone that says this period was
--     swept, and `boundary_at` is the range it was swept to.
--   * `deletion_requests` — the preview a person read and the commit that acted on
--     it, with the preview kept so "every deletion is audited" can be answered with
--     what was shown rather than with what was found later.
--   * `departures` — one row per departed member, so the command is replay-safe and
--     an operator can see what a departure revoked.
--
-- `retention_policies` already exists (migration 0001, section 10.3). What was
-- missing was its rows: this file adds the seeding function, the trigger that runs
-- it for a new workspace, and the backfill for the workspaces that already exist —
-- the same shape migration 0004 used for the default pipeline, and for the same
-- reason. A workspace without retention policy rows is a workspace whose retention
-- jobs have no boundary, and a retention job with no boundary must not guess one.
--
-- Nothing here deletes anything. Deletion is the application's, under the
-- privileges migration 0001 granted and the two it revoked, and this file adds no
-- privilege that would let a retention job reach `audit_events` or
-- `suppression_events`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- retention_policies: the rows of the 10.3 table
--
-- A function so the trigger and the backfill cannot drift, exactly as
-- `seed_default_pipeline_stages`. The ten kinds are the CHECK constraint's ten
-- kinds; the dispositions are the four it names.
--
-- Three of them carry no interval, which the `retention_policies_interval_consistent`
-- CHECK requires of `retain_indefinitely` and `retain_with_business_record`:
--
--   * business records are kept "until documented admin deletion", which is an
--     event rather than an interval;
--   * matched message bodies are kept "with business correspondence", so their
--     horizon is the firm's;
--   * research evidence is kept "with the firm while provider terms permit", and
--     the permission is per item — `evidence_items.retention_expires_at`, set from
--     the provider's reviewed terms — not per workspace.
--
-- `audit_events` records seven years and `database_backups` thirty-five days, and
-- neither is deleted by anything in this repository: the first has DELETE revoked
-- from both application roles, and the second is RDS's own retention in
-- `infra/modules/database`. The rows are here because a horizon nobody wrote down
-- is a horizon nobody can audit. See docs/decisions/g14-audit-events-are-not-deleted.md.
-- ---------------------------------------------------------------------------
CREATE FUNCTION seed_default_retention_policies(target_workspace uuid, seeded_at timestamptz) RETURNS void
LANGUAGE sql AS $policies$
  INSERT INTO retention_policies (workspace_id, data_kind, retention_interval, disposition, effective_from, updated_at)
  VALUES
    (target_workspace, 'business_records',         NULL,               'retain_indefinitely',         seeded_at, seeded_at),
    (target_workspace, 'suppression_history',      NULL,               'retain_indefinitely',         seeded_at, seeded_at),
    (target_workspace, 'audit_events',             INTERVAL '7 years', 'delete',                      seeded_at, seeded_at),
    (target_workspace, 'research_evidence',        NULL,               'retain_with_business_record', seeded_at, seeded_at),
    (target_workspace, 'unmatched_gmail_metadata', INTERVAL '30 days', 'delete',                      seeded_at, seeded_at),
    (target_workspace, 'raw_mime',                 INTERVAL '7 days',  'delete',                      seeded_at, seeded_at),
    (target_workspace, 'matched_message_body',     NULL,               'retain_with_business_record', seeded_at, seeded_at),
    (target_workspace, 'canceled_drafts',          INTERVAL '30 days', 'delete',                      seeded_at, seeded_at),
    (target_workspace, 'operational_logs',         INTERVAL '90 days', 'delete',                      seeded_at, seeded_at),
    (target_workspace, 'database_backups',         INTERVAL '35 days', 'delete',                      seeded_at, seeded_at)
  ON CONFLICT ON CONSTRAINT retention_policies_one_per_kind DO NOTHING;
$policies$;

CREATE FUNCTION seed_retention_for_new_workspace() RETURNS trigger
LANGUAGE plpgsql AS $new_workspace$
BEGIN
  PERFORM seed_default_retention_policies(NEW.id, NEW.created_at);
  RETURN NULL;
END;
$new_workspace$;

CREATE TRIGGER workspaces_seed_retention_policies
  AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION seed_retention_for_new_workspace();

-- Migrate, not expand: a named constant instant, never now().
SELECT seed_default_retention_policies(w.id, TIMESTAMPTZ '2026-09-20 00:00:00+00') FROM workspaces w;

-- ---------------------------------------------------------------------------
-- suppression_events.source gains `deletion_tombstone` (specification 10.3, 10.2)
--
-- "A documented deletion workflow ... retain[s] a minimal normalized suppression
-- tombstone where needed to prevent renewed contact."
--
-- That tombstone has to be a row in `suppression_events`, because
-- `effective_suppressions` is the one authoritative view for email and dialing. It
-- needs three properties: effective at once, terminal, and never reversible by a
-- salesperson. `prospect_opt_out` has all three, and this lane shipped its first
-- draft borrowing it — but the audit trail would then say a prospect opted out when
-- an admin ran a deletion, and that is a lie told by a table whose entire purpose is
-- to be believed.
--
-- So the vocabulary gains a seventh value with the same three properties and its own
-- name. Widening a CHECK is additive: an older binary reading these rows sees a
-- source it does not recognise, which `SUPPRESSING_SOURCES` in
-- `packages/domain/research/suppression.ts` fails closed on — anything not
-- demonstrably superseded counts as suppressing. Under expand/migrate/contract that
-- is the safe direction, and it is why the widening may ship with the code that
-- writes it rather than a release ahead of it.
--
-- `suppression_events_supersession_consistent` is untouched and still holds: a
-- deletion tombstone supersedes nothing, so it carries no `supersedes_event_id`.
-- The constraint keeps its name, so its failing-insert case in
-- `test/db/constraints.test.ts` keeps covering it.
-- ---------------------------------------------------------------------------
ALTER TABLE suppression_events DROP CONSTRAINT suppression_events_source_known;
ALTER TABLE suppression_events ADD CONSTRAINT suppression_events_source_known
  CHECK (source IN ('prospect_opt_out', 'prospect_do_not_call', 'salesperson_manual', 'import',
                    'deletion_tombstone', 'mistaken_entry_correction', 'admin_supersession'));

-- ---------------------------------------------------------------------------
-- retention_runs (Appendix C, specification 10.3)
--
-- One row per workspace, data kind and period. The period is the bounded range's
-- name and is also the second half of the Appendix C key `retention:{kind}:{period}`,
-- so the queue's `UNIQUE(workspace_id, kind, idempotency_key)` and this table's
-- uniqueness name the same unit of work and cannot disagree about what "already
-- done" means.
--
-- `data_kind` is a superset of `retention_policies.data_kind`: it adds
-- `job_payloads`, which is 13.2's "completed payloads are archived after the
-- operational window" rather than one of 10.3's ten rows. It is swept on a schedule
-- like the others and needs a ledger row like the others, and widening the closed
-- vocabulary in `retention_policies` would have put a queue payload into a table
-- whose rows are about prospect data. See docs/decisions/g14-retention-target-registry.md.
--
-- `boundary_at` is the instant the sweep deleted up to, computed from the policy's
-- interval and database time, and stored because "deleted at their boundaries"
-- (scenario 41) is only checkable against a boundary somebody wrote down.
--
-- DELETE and TRUNCATE are revoked below. A ledger a retention job could delete
-- would be a tombstone that does not survive the next retention job, which is the
-- one thing this table exists to be.
-- ---------------------------------------------------------------------------
CREATE TABLE retention_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  data_kind text NOT NULL,
  period text NOT NULL,
  boundary_at timestamptz,
  outcome text NOT NULL DEFAULT 'running',
  rows_deleted integer NOT NULL DEFAULT 0,
  rows_redacted integer NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT retention_runs_pkey PRIMARY KEY (workspace_id, id),
  -- The bounded range, once, per period. This is the `business_uniqueness`
  -- protection the handler registry makes `retention.batch` declare.
  CONSTRAINT retention_runs_one_per_period UNIQUE (workspace_id, data_kind, period),
  CONSTRAINT retention_runs_data_kind_known
    CHECK (data_kind IN ('business_records', 'suppression_history', 'audit_events', 'research_evidence',
                         'unmatched_gmail_metadata', 'raw_mime', 'matched_message_body', 'canceled_drafts',
                         'operational_logs', 'database_backups', 'job_payloads')),
  -- A calendar day in UTC, which is what the scheduler composes the key from.
  CONSTRAINT retention_runs_period_shape CHECK (period ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT retention_runs_outcome_known
    CHECK (outcome IN ('running', 'swept', 'retained', 'declared_pending', 'external', 'no_policy')),
  -- A finished run names its outcome and its completion together; a running one has
  -- neither. `running` with a completion, or `swept` without one, is a half-written
  -- ledger row and the ledger is the tombstone.
  CONSTRAINT retention_runs_completion_consistent CHECK ((outcome = 'running') = (completed_at IS NULL)),
  -- Only a sweep may have removed anything. `retained` is the audit-events and
  -- suppression-history case, and it must be provably a no-op.
  CONSTRAINT retention_runs_only_a_sweep_removes
    CHECK (outcome = 'swept' OR (rows_deleted = 0 AND rows_redacted = 0)),
  CONSTRAINT retention_runs_counts_not_negative CHECK (rows_deleted >= 0 AND rows_redacted >= 0),
  -- A sweep deleted up to a boundary; an outcome that deleted nothing may have none.
  CONSTRAINT retention_runs_sweep_has_boundary CHECK (outcome <> 'swept' OR boundary_at IS NOT NULL),
  CONSTRAINT retention_runs_detail_is_object CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT retention_runs_completed_not_before_started
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX retention_runs_by_kind ON retention_runs (workspace_id, data_kind, started_at DESC);

-- ---------------------------------------------------------------------------
-- deletion_requests (specification 10.3: "a documented deletion workflow")
--
-- "A documented deletion workflow removes ordinary personal and correspondence data
-- while retaining a minimal normalized suppression tombstone where needed to prevent
-- renewed contact. ... Every deletion and export is audited."
--
-- Two commands, one row. The preview is stored rather than recomputed because the
-- thing an admin approved is the thing they were shown, and a commit that found more
-- rows than the preview did is a fact worth being able to see afterwards.
-- `preview_hash` is what the commit presents to prove it is committing that preview;
-- a stale client holding yesterday's preview is refused rather than silently
-- deleting a larger set.
--
-- `tombstone_event_ids` are the `suppression_events` this deletion inserted. They
-- are ids, not keys: the handles themselves are the personal data being removed, and
-- a deletion record that quoted them would keep a copy of what it deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE deletion_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  target_kind text NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  requested_by_user_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  preview jsonb NOT NULL,
  preview_hash text NOT NULL,
  state text NOT NULL DEFAULT 'previewed',
  command_id text,
  committed_at timestamptz,
  committed_by_user_id uuid,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  tombstone_event_ids text[] NOT NULL DEFAULT '{}',
  CONSTRAINT deletion_requests_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT deletion_requests_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id),
  CONSTRAINT deletion_requests_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT deletion_requests_requester_fkey FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT deletion_requests_committer_fkey FOREIGN KEY (workspace_id, committed_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT deletion_requests_target_kind_known CHECK (target_kind IN ('firm', 'contact')),
  -- A contact deletion names the contact; a firm deletion may not, because a firm
  -- deletion that quietly meant one contact is the most dangerous kind of typo.
  CONSTRAINT deletion_requests_contact_named CHECK ((target_kind = 'contact') = (contact_id IS NOT NULL)),
  CONSTRAINT deletion_requests_state_known CHECK (state IN ('previewed', 'committed')),
  CONSTRAINT deletion_requests_commit_consistent
    CHECK ((state = 'committed') = (committed_at IS NOT NULL)
           AND (state = 'committed') = (committed_by_user_id IS NOT NULL)),
  CONSTRAINT deletion_requests_preview_is_object CHECK (jsonb_typeof(preview) = 'object'),
  CONSTRAINT deletion_requests_outcome_is_object CHECK (jsonb_typeof(outcome) = 'object'),
  CONSTRAINT deletion_requests_preview_hash_shape CHECK (preview_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT deletion_requests_command_id_bounded
    CHECK (command_id IS NULL OR (btrim(command_id) <> '' AND length(command_id) <= 128)),
  CONSTRAINT deletion_requests_tombstones_bounded
    CHECK (cardinality(tombstone_event_ids) <= 500),
  CONSTRAINT deletion_requests_committed_not_before_requested
    CHECK (committed_at IS NULL OR committed_at >= requested_at)
);

-- One command id commits at most one deletion, so a replay cannot delete twice.
CREATE UNIQUE INDEX deletion_requests_one_per_command
  ON deletion_requests (workspace_id, command_id)
  WHERE command_id IS NOT NULL;

CREATE INDEX deletion_requests_by_firm ON deletion_requests (workspace_id, firm_id, requested_at DESC);

-- ---------------------------------------------------------------------------
-- departures (specification 10.3, Appendix F)
--
-- "Departure immediately revokes membership, devices, sessions, and OAuth grants and
-- deletes refresh-token material. Firm-related business correspondence remains;
-- private drafts, raw mailbox material, and unrelated metadata expire under the table
-- above."
--
-- `UNIQUE(workspace_id, user_id)` is the whole of the command's replay safety: a
-- second departure for the same member finds the row and reports it rather than
-- revoking an already-revoked device a second time and writing a second audit event
-- that claims something happened.
--
-- The counts are an `outcome` object rather than columns because they are a report,
-- not a key, and the set of things a departure revokes grows as lanes land. What is
-- a column is `refresh_token_material_deleted`: it is the one irreversible thing in
-- the list, and a boolean somebody can see beats a number inside a blob.
-- ---------------------------------------------------------------------------
CREATE TABLE departures (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  user_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  departed_at timestamptz NOT NULL DEFAULT now(),
  command_id text,
  refresh_token_material_deleted boolean NOT NULL DEFAULT false,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT departures_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT departures_one_per_user UNIQUE (workspace_id, user_id),
  CONSTRAINT departures_user_fkey FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT departures_requester_fkey FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  -- 5.2: "The last active admin cannot deactivate themselves or be removed", and a
  -- departure is the most complete form of removal there is.
  CONSTRAINT departures_not_self CHECK (user_id <> requested_by_user_id),
  CONSTRAINT departures_outcome_is_object CHECK (jsonb_typeof(outcome) = 'object'),
  CONSTRAINT departures_command_id_bounded
    CHECK (command_id IS NULL OR (btrim(command_id) <> '' AND length(command_id) <= 128))
);

CREATE UNIQUE INDEX departures_one_per_command
  ON departures (workspace_id, command_id)
  WHERE command_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then, so each of these needs its own grant.
--
-- All three are append-and-amend, never remove. A retention ledger a retention job
-- could delete is not a tombstone; a deletion record the deletion workflow could
-- delete would make "every deletion is audited" a statement about rows that may no
-- longer be there; and a departure record that could be removed would let a
-- revocation be un-recorded. UPDATE stays, because a run completes and a preview is
-- committed, and both are amendments to a row that already names its subject.
--
-- Nothing here touches `audit_events` or `suppression_events`. Migration 0001's
-- `REVOKE UPDATE, DELETE, TRUNCATE` on both is what makes "no retention job can
-- touch them" a privilege rather than a promise, and this file deliberately does not
-- re-grant it.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON retention_runs TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE ON deletion_requests TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE ON departures TO app_runtime, migration;
REVOKE DELETE, TRUNCATE ON retention_runs FROM app_runtime, migration;
REVOKE DELETE, TRUNCATE ON deletion_requests FROM app_runtime, migration;
REVOKE DELETE, TRUNCATE ON departures FROM app_runtime, migration;
