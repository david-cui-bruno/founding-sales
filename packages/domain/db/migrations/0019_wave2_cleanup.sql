-- ---------------------------------------------------------------------------
-- 0019_wave2_cleanup.sql — what wave 1 and W2-S left for the schema (lane W2-M)
--
-- A contract migration, like 0015 and 0018: both service ranges move to {19, 19} in
-- the same release (`packages/domain/db/schemaRange.ts`), and the release is a
-- stop-migrate-start one (`release-deploy.sh --schema-change`). The images of the
-- previous release declare {18, 18} and refuse this schema at startup; nothing of
-- theirs runs while it is applied, because both services are at zero first.
--
-- `infra/scripts/schema-preflight-0019.sh` (`fss admin schema-preflight 0019`) prints,
-- read-only and before the stop, every count below: what this file destroys, what it
-- converts, and what would make it refuse.
--
-- ## What goes
--
--   (a) Research (deleted from the code by PR 253): its eight tables, the function
--       that seeded three of them for every workspace and the workspace-insert trigger
--       that called it. The seeded configuration rows go with them.
--   (b) `record_merge_events` (no writer since PR 262). Its rows are **kept as
--       history**: each is copied into `audit_events` as `record_merge.archived`, with
--       every column in the detail, before the table is dropped.
--   (c) `mailbox_send_days.direct_sent` (no reader or writer since PR 262) and the
--       count CHECK over it, re-added over the four counts that remain.
--   (d) The personal-Gmail guard's two columns on `sending_domains` (PR 253 deleted
--       the guard) and the CHECK over the first.
--   (e) The audited enrollment migration (the new-version-plus-migration path S3
--       replaces with edit in place): `enrollment_migrations`, its items,
--       `sequence_enrollments.migration_paused_at`, and the `migration` shift reason
--       and `migration_superseded` end reason nothing else writes.
--   (f) The LinkedIn markers 0018 kept: `linkedin_task` in the two channel CHECKs and
--       `removed` in the five vocabularies 0018 converted into. Production stored no
--       LinkedIn step, execution or pause when 0018 ran (its preflight, 26 September
--       2026 01:49 UTC) and nothing can write one since, so these are empty.
--   (g) The settings keys `alert_thresholds` and `client_version_range` (retired by
--       wave 1): their rows are deleted, and `postal_address` joins the CHECK (S3:
--       the footer composed at send).
--   (h) The hold reason codes `domain_cap` and `dead_job` (nothing opens either since
--       wave 1), but only a code no row references; a referenced one stays.
--
-- ## What is relaxed
--
--   (i) Edit in place (S3). The triggers that froze an approved template version and
--       the steps of a published sequence version are dropped, and so is the CHECK
--       that an approved body contains the stop line: with a postal address set, the
--       server composes the footer at send, so the template does not carry it. What
--       freezes the bytes of a send is the outbound fence, which stores the rendered
--       subject and body before anything is dispatched.
--   (j) The four CHECKs W2-S now satisfies with placeholders (PR 262): a snooze's
--       reason may be absent; a usable phone needs no evidence columns; a verified or
--       enabled calling identity needs no attestation columns; a posture needs no
--       `review_at`. The placeholders can go in a later application release.
--
-- ## What is kept, deliberately
--
--   * `sequence_enrollments.state = 'review_required'` and `review_union_milliseconds`:
--     existing rows are reactivated by the scheduler through the resume path, with one
--     shift (PR 262). A later migration drops the value once the preflight counts none.
--   * The hold codes W2-S stopped producing (`long_hold_review`, `posture_overdue`, …):
--     desktop 1.0.11 has copy for them.
--   * `research` as a pause channel and a blocked action kind: every all-automation
--     hold stores it, so dropping it would rewrite history.
--
-- ## The refusal (FS019)
--
-- (e) and (f) destroy rows only if any exist, and the preflight says there are none.
-- If that has stopped being true by the time this runs, the block below raises FS019
-- with the counts and changes nothing — the release stops with schema 18 intact, and
-- the coordinator decides with David before this file is amended (it has not been
-- applied anywhere then). There is no override switch.
--
-- ## One transaction
--
-- The runner applies this file inside one transaction, so a refusal or any failure
-- leaves schema 18 as it was.
-- ---------------------------------------------------------------------------

DO $refuse$
DECLARE
  v_linkedin_steps bigint;
  v_linkedin_executions bigint;
  v_removed_executions bigint;
  v_removed_shifts bigint;
  v_removed_holds bigint;
  v_removed_pauses bigint;
  v_migrations bigint;
  v_migration_items bigint;
  v_migration_shifts bigint;
  v_migration_superseded bigint;
  v_migration_paused bigint;
BEGIN
  SELECT count(*) INTO v_linkedin_steps FROM sequence_steps WHERE channel = 'linkedin_task';
  SELECT count(*) INTO v_linkedin_executions FROM step_executions WHERE channel = 'linkedin_task';
  SELECT count(*) INTO v_removed_executions FROM step_executions
   WHERE completion_source = 'removed' OR result = 'removed';
  SELECT count(*) INTO v_removed_shifts FROM step_execution_shifts WHERE reason = 'removed';
  SELECT count(*) INTO v_removed_holds FROM active_holds WHERE 'removed' = ANY (blocked_action_kinds);
  SELECT count(*) INTO v_removed_pauses FROM administrative_pauses WHERE channel = 'removed';
  SELECT count(*) INTO v_migrations FROM enrollment_migrations;
  SELECT count(*) INTO v_migration_items FROM enrollment_migration_items;
  SELECT count(*) INTO v_migration_shifts FROM step_execution_shifts WHERE reason = 'migration';
  SELECT count(*) INTO v_migration_superseded FROM sequence_enrollments WHERE end_reason = 'migration_superseded';
  SELECT count(*) INTO v_migration_paused FROM sequence_enrollments WHERE migration_paused_at IS NOT NULL;

  IF v_linkedin_steps + v_linkedin_executions + v_removed_executions + v_removed_shifts + v_removed_holds
     + v_removed_pauses + v_migrations + v_migration_items + v_migration_shifts + v_migration_superseded
     + v_migration_paused > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'FS019',
      MESSAGE = format(
        '0019 refused: linkedin_steps=%s linkedin_executions=%s removed_executions=%s removed_shifts=%s removed_holds=%s removed_pauses=%s enrollment_migrations=%s enrollment_migration_items=%s migration_shifts=%s migration_superseded=%s migration_paused=%s',
        v_linkedin_steps, v_linkedin_executions, v_removed_executions, v_removed_shifts, v_removed_holds,
        v_removed_pauses, v_migrations, v_migration_items, v_migration_shifts, v_migration_superseded,
        v_migration_paused),
      DETAIL = '0019 drops these vocabulary values and tables only when no row uses them; schema 18 is unchanged.',
      HINT = 'infra/scripts/schema-preflight-0019.sh prints the same counts before the stop. Decide with the owner, then amend 0019 before releasing it.';
  END IF;
END
$refuse$;

-- ---------------------------------------------------------------------------
-- (a) Research
--
-- The trigger first, so no workspace insert in this transaction reaches a function
-- that is about to go; then both functions; then the eight tables in one statement,
-- which drops the foreign keys between them with them.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS workspaces_seed_research ON workspaces;
DROP FUNCTION IF EXISTS seed_research_for_new_workspace();
DROP FUNCTION IF EXISTS seed_research_configuration(uuid, timestamptz);
DROP TABLE IF EXISTS
  research_suggestions,
  research_firm_runs,
  firm_locations,
  research_pages,
  research_provider_ledger,
  research_route_policies,
  research_providers,
  research_settings;

-- ---------------------------------------------------------------------------
-- (b) record_merge_events, kept as history in audit_events
--
-- The merge's record has been its audit event since PR 262 (`firm.merged`), and a
-- firm merge wrote that event before then too. Each stored row is copied anyway,
-- whole, so nothing a merge recorded is lost with the table. The subject is the record
-- that survived; the actor is the person who merged, or the system when none was
-- recorded.
-- ---------------------------------------------------------------------------
INSERT INTO audit_events (workspace_id, occurred_at, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
SELECT workspace_id,
       occurred_at,
       CASE WHEN performed_by_user_id IS NULL THEN 'system' ELSE 'user' END,
       performed_by_user_id,
       'record_merge.archived',
       record_kind,
       target_id::text,
       jsonb_build_object(
         'recordMergeEventId', id,
         'recordKind', record_kind,
         'sourceId', source_id,
         'targetId', target_id,
         'firmId', firm_id,
         'commandId', command_id,
         'preserved', preserved,
         'archivedBy', 'migration 0019')
  FROM record_merge_events
 ORDER BY occurred_at, id;

DROP TABLE IF EXISTS record_merge_events;

-- ---------------------------------------------------------------------------
-- (c) mailbox_send_days.direct_sent
-- ---------------------------------------------------------------------------
ALTER TABLE mailbox_send_days DROP CONSTRAINT IF EXISTS mailbox_send_days_counts_not_negative;
ALTER TABLE mailbox_send_days DROP COLUMN IF EXISTS direct_sent;
ALTER TABLE mailbox_send_days
  ADD CONSTRAINT mailbox_send_days_counts_not_negative
    CHECK (automated_sent >= 0 AND bounces >= 0 AND opt_outs >= 0 AND provider_errors >= 0);

-- ---------------------------------------------------------------------------
-- (d) The personal-Gmail guard's columns
-- ---------------------------------------------------------------------------
ALTER TABLE sending_domains DROP CONSTRAINT IF EXISTS sending_domains_guard_bounded;
ALTER TABLE sending_domains
  DROP COLUMN IF EXISTS personal_gmail_guard_per_24h,
  DROP COLUMN IF EXISTS reply_only_opt_out;

-- ---------------------------------------------------------------------------
-- (e) The audited enrollment migration
--
-- Empty, by the refusal above. Items before the migrations they reference.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS enrollment_migration_items;
DROP TABLE IF EXISTS enrollment_migrations;
ALTER TABLE sequence_enrollments DROP COLUMN IF EXISTS migration_paused_at;

ALTER TABLE sequence_enrollments DROP CONSTRAINT IF EXISTS sequence_enrollments_end_reason_known;
ALTER TABLE sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_end_reason_known
    CHECK (end_reason IS NULL OR end_reason IN (
      'human_reply', 'engaged_call', 'opt_out', 'firm_suppressed',
      'stage_won', 'stage_lost', 'direct_send', 'send_skipped', 'reassignment',
      'sequence_complete', 'admin_stop'
    ));

-- ---------------------------------------------------------------------------
-- (f) The LinkedIn markers
--
-- Each CHECK keeps its name, so the constraint cases and every error mapper that
-- names one still do. Adding a CHECK validates every row, so a value the refusal
-- above missed fails the migration rather than surviving it.
-- ---------------------------------------------------------------------------
ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_channel_known;
ALTER TABLE sequence_steps
  ADD CONSTRAINT sequence_steps_channel_known CHECK (channel IN ('email', 'call_task'));

ALTER TABLE step_executions
  DROP CONSTRAINT IF EXISTS step_executions_channel_known,
  DROP CONSTRAINT IF EXISTS step_executions_completion_source_known,
  DROP CONSTRAINT IF EXISTS step_executions_result_known;
ALTER TABLE step_executions
  ADD CONSTRAINT step_executions_channel_known CHECK (channel IN ('email', 'call_task')),
  ADD CONSTRAINT step_executions_completion_source_known
    CHECK (completion_source IS NULL OR completion_source IN ('call_log', 'send', 'admin', 'system')),
  ADD CONSTRAINT step_executions_result_known
    CHECK (result IS NULL OR result IN (
      'sent', 'skipped', 'no_email', 'voicemail_left', 'no_answer', 'busy', 'connected', 'not_applicable'
    ));

ALTER TABLE step_execution_shifts DROP CONSTRAINT IF EXISTS step_execution_shifts_reason_known;
ALTER TABLE step_execution_shifts
  ADD CONSTRAINT step_execution_shifts_reason_known CHECK (reason IN ('hold_union', 'send_window', 'retry_call'));

ALTER TABLE active_holds DROP CONSTRAINT IF EXISTS active_holds_blocked_action_kinds_known;
ALTER TABLE active_holds
  ADD CONSTRAINT active_holds_blocked_action_kinds_known
    CHECK (cardinality(blocked_action_kinds) > 0
           AND blocked_action_kinds <@ ARRAY['email_send', 'call_task', 'dial_authorization',
                                             'enrollment_advance', 'research']::text[]);

ALTER TABLE administrative_pauses DROP CONSTRAINT IF EXISTS administrative_pauses_channel_known;
ALTER TABLE administrative_pauses
  ADD CONSTRAINT administrative_pauses_channel_known
    CHECK (channel IS NULL OR channel IN ('email', 'call', 'research'));

-- ---------------------------------------------------------------------------
-- (g) Settings
--
-- The rows go before the narrowed CHECK, which validates every row. The delete is the
-- whole history of both keys, superseded versions included, as 0015 did for
-- `postal_footer`.
-- ---------------------------------------------------------------------------
DELETE FROM workspace_settings WHERE setting_key IN ('alert_thresholds', 'client_version_range');

ALTER TABLE workspace_settings DROP CONSTRAINT IF EXISTS workspace_settings_key_known;
ALTER TABLE workspace_settings
  ADD CONSTRAINT workspace_settings_key_known
    CHECK (setting_key IN ('business_time_zone', 'postal_address', 'sending_enabled'));

-- ---------------------------------------------------------------------------
-- (h) The two reason codes nothing opens, where nothing references them
--
-- Four tables reference `hold_reason_codes`. A code any row still names stays, and
-- the notice says so, because deleting it would fail the foreign key and this file.
-- ---------------------------------------------------------------------------
DELETE FROM hold_reason_codes c
 WHERE c.code IN ('domain_cap', 'dead_job')
   AND NOT EXISTS (SELECT 1 FROM active_holds h WHERE h.reason_code = c.code)
   AND NOT EXISTS (SELECT 1 FROM administrative_pauses p WHERE p.reason_code = c.code)
   AND NOT EXISTS (SELECT 1 FROM crm_domain_events e WHERE e.reason_code = c.code)
   AND NOT EXISTS (SELECT 1 FROM step_executions x WHERE x.hold_reason_code = c.code);

DO $kept$
DECLARE
  v_kept text;
BEGIN
  SELECT string_agg(code, ', ' ORDER BY code) INTO v_kept
    FROM hold_reason_codes WHERE code IN ('domain_cap', 'dead_job');
  IF v_kept IS NOT NULL THEN
    RAISE NOTICE '0019 kept the hold reason code(s) %: a stored row still references them', v_kept;
  END IF;
END
$kept$;

-- ---------------------------------------------------------------------------
-- (i) Edit in place
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS template_versions_approved_immutable ON template_versions;
DROP FUNCTION IF EXISTS assert_approved_template_immutable();
ALTER TABLE template_versions DROP CONSTRAINT IF EXISTS template_versions_approved_has_stop_line;

DROP TRIGGER IF EXISTS sequence_steps_only_on_a_draft ON sequence_steps;
DROP FUNCTION IF EXISTS assert_sequence_step_version_is_draft();

-- ---------------------------------------------------------------------------
-- (j) The CHECKs W2-S satisfies with placeholders
-- ---------------------------------------------------------------------------
ALTER TABLE today_snoozes DROP CONSTRAINT IF EXISTS today_snoozes_reason_present;
ALTER TABLE today_snoozes ALTER COLUMN reason DROP NOT NULL;
ALTER TABLE today_snoozes
  ADD CONSTRAINT today_snoozes_reason_bounded
    CHECK (reason IS NULL OR (btrim(reason) <> '' AND length(reason) <= 300));

ALTER TABLE phone_routes DROP CONSTRAINT IF EXISTS phone_routes_usable_is_evidenced;

ALTER TABLE calling_identities
  DROP CONSTRAINT IF EXISTS calling_identities_verification_recorded,
  DROP CONSTRAINT IF EXISTS calling_identities_enabled_requires_verification;

ALTER TABLE state_postures DROP CONSTRAINT IF EXISTS state_postures_review_after_effective;
ALTER TABLE state_postures ALTER COLUMN review_at DROP NOT NULL;
