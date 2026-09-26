-- ---------------------------------------------------------------------------
-- 0018_remove_linkedin.sql — the schema LinkedIn left behind (lane A4)
--
-- LinkedIn will never ship (David, 25 September 2026). PR 234 deleted it from the
-- code and left the schema, because what production stores was unknown; its body
-- lists every object that still names LinkedIn, and this file removes or converts
-- each one — except the two channel CHECKs, which keep `linkedin_task` as the stored
-- marker of a removed channel (below).
--
-- This is a contract migration, like 0015: both service ranges move to {18, 18} in
-- the same release (`packages/domain/db/schemaRange.ts`), and the release is a
-- stop-migrate-start one (`docs/greenfield/release.md`, "Migration 0018").
--
-- ## What is kept, what is converted, and what needs the owner
--
-- Every stored LinkedIn value gets one of three dispositions:
--
--   * **Kept where the owner sees it.** A contact's `linkedin_url` is appended to the
--     contact's `title` (`Managing Partner · https://www.linkedin.com/in/…`), the one
--     free-text field of a contact the desktop shows and lets a person edit. Contacts
--     have no notes column and no attributes column; `evidence_items` and
--     `record_aliases` are not shown anywhere. A deletion under 10.3 blanks `title`, so
--     the URL leaves with the person exactly as the column did.
--   * **Converted without asking**, because nothing a person wrote is lost:
--     `linkedin_reply` leaves every version's `stop_conditions` (it could never fire
--     again); `linkedin_task` leaves every hold's `blocked_action_kinds` (nothing does
--     that action); a Today item of kind `linkedin_due` is deleted (Today items are
--     rebuilt from the executions every morning, and the build already cancelled
--     them); `today_snapshots.linkedin_due` is a derived count. A hold that blocked
--     *only* `linkedin_task` — a LinkedIn channel pause's hold — keeps its history and
--     blocks `removed`, and the pause's channel becomes `removed`.
--   * **Refused unless the owner has decided.** Three values hold words or a URL that
--     would be erased: a step's `linkedin_message` (text Callie wrote), a row of
--     `enrollment_linkedin_results` (a prospect's recorded reply and its note), and a
--     contact URL that does not fit beside the title in 200 characters. When any of the
--     three is present the migration raises and changes nothing, naming the counts,
--     unless the session says `fss.remove_linkedin_history = 'on'` — which
--     `fss migrate --remove-linkedin-history` sets, and which the operator passes only
--     after the owner has seen `infra/scripts/schema-preflight-0018.sh`'s counts.
--
-- With the setting on, the rows that were LinkedIn *work* — steps, their executions,
-- their shifts — stay, as history, and are never deleted: a version's steps keep their
-- ordinals and delays, which a person is still shown. A step's and an execution's
-- channel stays `linkedin_task`, and `sequence_steps_channel_known` and
-- `step_executions_channel_known` keep admitting it, deliberately: it is the stored
-- marker of a removed channel that lane A2's read-only representation keys on
-- (`channel: 'removed', removedChannel: 'linkedin'` on the wire, a greyed row on the
-- desktop), and that `isStepChannel` refuses, so a held execution stays held with
-- `long_hold_review` and a person stops or migrates its enrollment. What those rows
-- carried beyond the channel becomes the neutral `removed`: `open_and_copy`,
-- `handed_off` and the `linkedin_grace` shift reason, which no reader shows. An
-- enrollment that ended `linkedin_reply` ended because a person replied, and says
-- `human_reply`. The step's message and the recorded replies are erased with their
-- column and table.
--
-- ## One transaction
--
-- The runner applies this file inside one transaction, so a refusal or any failure
-- leaves schema 17 exactly as it was. Every DROP says IF EXISTS and every conversion
-- names the value it converts, so the statements are safe to run again; the refusal
-- block reads the dropped columns only while they exist.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- (a) The counts, (b) the URL kept in the title, (c) the refusal
--
-- `infra/scripts/schema-preflight-0018.sh` runs the same counts read-only before the
-- release stops anything (`packages/domain/db/linkedinRemoval.ts`); the seeded test
-- asserts the two agree.
-- ---------------------------------------------------------------------------
DO $remove_linkedin$
DECLARE
  v_step_messages bigint := 0;
  v_results bigint := 0;
  v_unfit_urls bigint := 0;
  v_contact_urls bigint := 0;
  v_setting text := coalesce(current_setting('fss.remove_linkedin_history', true), '');
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'contacts' AND column_name = 'linkedin_url') THEN
    EXECUTE $count$
      SELECT count(*) FILTER (WHERE linkedin_url IS NOT NULL),
             count(*) FILTER (
               WHERE linkedin_url IS NOT NULL
                 AND (title IS NULL OR position(linkedin_url IN title) = 0)
                 AND length(CASE WHEN title IS NULL THEN linkedin_url ELSE title || ' · ' || linkedin_url END) > 200)
        FROM contacts
    $count$ INTO v_contact_urls, v_unfit_urls;

    -- (b) Kept where the owner sees it: appended to the title when it fits, and never
    -- twice. `updated_at` moves so a cached copy of the contact is replaced.
    EXECUTE $keep$
      UPDATE contacts
         SET title = CASE WHEN title IS NULL THEN linkedin_url ELSE title || ' · ' || linkedin_url END,
             updated_at = greatest(updated_at, now())
       WHERE linkedin_url IS NOT NULL
         AND (title IS NULL OR position(linkedin_url IN title) = 0)
         AND length(CASE WHEN title IS NULL THEN linkedin_url ELSE title || ' · ' || linkedin_url END) <= 200
    $keep$;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'sequence_steps' AND column_name = 'linkedin_message') THEN
    EXECUTE $count$
      SELECT count(*) FROM sequence_steps WHERE linkedin_message IS NOT NULL AND btrim(linkedin_message) <> ''
    $count$ INTO v_step_messages;
  END IF;

  IF to_regclass('enrollment_linkedin_results') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM enrollment_linkedin_results' INTO v_results;
  END IF;

  -- (c) The message is the first thing an operator reads, and the tool's log line
  -- keeps 200 characters of it, so the counts come first.
  IF (v_step_messages > 0 OR v_results > 0 OR v_unfit_urls > 0) AND v_setting <> 'on' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'FS018',
      MESSAGE = format(
        '0018 refused: linkedin_message=%s linkedin_results=%s unfit_urls=%s; after the owner sees these, rerun with fss.remove_linkedin_history=on',
        v_step_messages, v_results, v_unfit_urls),
      DETAIL = format(
        'sequence_steps.linkedin_message non-empty: %s; enrollment_linkedin_results rows: %s; contacts.linkedin_url: %s, of which %s do not fit beside the title in 200 characters',
        v_step_messages, v_results, v_contact_urls, v_unfit_urls),
      HINT = 'infra/scripts/schema-preflight-0018.sh prints the same counts without stopping anything; fss migrate --remove-linkedin-history (deploy.sh release --remove-linkedin-history) sets the session setting.';
  END IF;
END
$remove_linkedin$;

-- ---------------------------------------------------------------------------
-- (d) stop_conditions: four mandatory members, not five
--
-- A published version is immutable by trigger (0012), and rightly: this is the one
-- change to a published version that is not an edit of the plan, so the trigger is
-- set aside for this statement only, inside this transaction. The CHECK that required
-- `linkedin_reply` goes first, or no row could lose it.
-- ---------------------------------------------------------------------------
ALTER TABLE sequence_versions
  DROP CONSTRAINT IF EXISTS sequence_versions_stop_conditions_complete,
  DROP CONSTRAINT IF EXISTS sequence_versions_stop_conditions_known;

ALTER TABLE sequence_versions
  ALTER COLUMN stop_conditions SET DEFAULT ARRAY['human_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed'];

ALTER TABLE sequence_versions DISABLE TRIGGER sequence_versions_immutable_once_published;
UPDATE sequence_versions
   SET stop_conditions = array_remove(stop_conditions, 'linkedin_reply')
 WHERE 'linkedin_reply' = ANY (stop_conditions);
ALTER TABLE sequence_versions ENABLE TRIGGER sequence_versions_immutable_once_published;

ALTER TABLE sequence_versions
  ADD CONSTRAINT sequence_versions_stop_conditions_known
    CHECK (stop_conditions <@ ARRAY['human_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed']::text[]),
  ADD CONSTRAINT sequence_versions_stop_conditions_complete
    CHECK (ARRAY['human_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed']::text[] <@ stop_conditions);

-- ---------------------------------------------------------------------------
-- (e) Every vocabulary that admitted a LinkedIn value
--
-- Each CHECK keeps its name, so everything that names it — the constraint cases, an
-- error mapper — still does. The rows go first, then the CHECK, which validates every
-- row it is added over: a value this file missed fails the migration rather than
-- surviving it.
-- ---------------------------------------------------------------------------

-- sequence_steps and step_executions keep their channel CHECKs as 0012 wrote them:
-- `linkedin_task` is the removed channel's stored marker (see the header), so no step
-- or execution row changes channel, no published step is rewritten, and the step
-- trigger is not set aside. The three CHECKs over the step's message go with the
-- message in (g).
--
-- step_executions. State and channel are untouched: a held LinkedIn execution stays
-- held, and stays a `linkedin_task`.
ALTER TABLE step_executions
  DROP CONSTRAINT IF EXISTS step_executions_completion_source_known,
  DROP CONSTRAINT IF EXISTS step_executions_result_known;
UPDATE step_executions SET completion_source = 'removed' WHERE completion_source = 'open_and_copy';
UPDATE step_executions SET result = 'removed' WHERE result = 'handed_off';
ALTER TABLE step_executions
  ADD CONSTRAINT step_executions_completion_source_known
    CHECK (completion_source IS NULL
           OR completion_source IN ('call_log', 'send', 'admin', 'system', 'removed')),
  ADD CONSTRAINT step_executions_result_known
    CHECK (result IS NULL OR result IN (
      'sent', 'skipped', 'no_email', 'voicemail_left', 'no_answer',
      'busy', 'connected', 'not_applicable', 'removed'
    ));

-- step_execution_shifts. Append-only for the application; the owner may convert.
ALTER TABLE step_execution_shifts DROP CONSTRAINT IF EXISTS step_execution_shifts_reason_known;
UPDATE step_execution_shifts SET reason = 'removed' WHERE reason = 'linkedin_grace';
ALTER TABLE step_execution_shifts
  ADD CONSTRAINT step_execution_shifts_reason_known
    CHECK (reason IN ('hold_union', 'send_window', 'migration', 'retry_call', 'removed'));

-- sequence_enrollments. A LinkedIn reply was a person replying.
ALTER TABLE sequence_enrollments DROP CONSTRAINT IF EXISTS sequence_enrollments_end_reason_known;
UPDATE sequence_enrollments SET end_reason = 'human_reply' WHERE end_reason = 'linkedin_reply';
ALTER TABLE sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_end_reason_known
    CHECK (end_reason IS NULL OR end_reason IN (
      'human_reply', 'engaged_call', 'opt_out', 'firm_suppressed',
      'stage_won', 'stage_lost', 'direct_send', 'send_skipped', 'reassignment',
      'sequence_complete', 'admin_stop', 'migration_superseded'
    ));

-- active_holds. `linkedin_task` leaves every hold; a hold that blocked nothing else
-- keeps its row and history and blocks `removed`, because a hold blocks at least one
-- kind and administrative pauses, mail recoveries and message effects reference it.
ALTER TABLE active_holds DROP CONSTRAINT IF EXISTS active_holds_blocked_action_kinds_known;
UPDATE active_holds
   SET blocked_action_kinds = CASE
         WHEN cardinality(array_remove(blocked_action_kinds, 'linkedin_task')) = 0 THEN ARRAY['removed']::text[]
         ELSE array_remove(blocked_action_kinds, 'linkedin_task')
       END
 WHERE 'linkedin_task' = ANY (blocked_action_kinds);
ALTER TABLE active_holds
  ADD CONSTRAINT active_holds_blocked_action_kinds_known
    CHECK (cardinality(blocked_action_kinds) > 0
           AND blocked_action_kinds <@ ARRAY['email_send', 'call_task', 'dial_authorization',
                                             'enrollment_advance', 'research', 'removed']::text[]);

-- administrative_pauses. The pause row is the history of who paused what.
ALTER TABLE administrative_pauses DROP CONSTRAINT IF EXISTS administrative_pauses_channel_known;
UPDATE administrative_pauses SET channel = 'removed' WHERE channel = 'linkedin';
ALTER TABLE administrative_pauses
  ADD CONSTRAINT administrative_pauses_channel_known
    CHECK (channel IS NULL OR channel IN ('email', 'call', 'research', 'removed'));

-- ---------------------------------------------------------------------------
-- (f) Today: the lane function, the card function, the counts CHECK, the kinds
--
-- `today_refresh_card` is 0008's body without `linkedin_due`. It is replaced before
-- the Today rows are deleted, so the trigger those deletes fire writes the card
-- without the column that is about to go. Dropping `linkedin_due` would take
-- `today_snapshots_counts_nonnegative` with it, so the CHECK is dropped and added back
-- over the four counts that remain.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION today_refresh_card(p_workspace_id uuid, p_snapshot_date date, p_firm_id uuid)
RETURNS void LANGUAGE plpgsql AS $today$
DECLARE
  v_lane text;
  v_sort timestamptz;
  v_open integer;
  v_replies integer;
  v_emails integer;
  v_calls integer;
  v_assignee uuid;
BEGIN
  SELECT count(*)::integer,
         (count(*) FILTER (WHERE kind = 'reply'))::integer,
         (count(*) FILTER (WHERE kind = 'email_due'))::integer,
         (count(*) FILTER (WHERE kind = 'call_due'))::integer
    INTO v_open, v_replies, v_emails, v_calls
    FROM today_items
   WHERE workspace_id = p_workspace_id
     AND snapshot_date = p_snapshot_date
     AND firm_id = p_firm_id
     AND status = 'open';

  -- `item_key` is the last tiebreak rather than `id`, so two databases holding the
  -- same tasks choose the same one: a generated uuid is not the same in both.
  SELECT lane, due_at
    INTO v_lane, v_sort
    FROM today_items
   WHERE workspace_id = p_workspace_id
     AND snapshot_date = p_snapshot_date
     AND firm_id = p_firm_id
     AND status = 'open'
   ORDER BY today_lane_precedence(lane), due_at, item_key
   LIMIT 1;

  SELECT assigned_user_id INTO v_assignee
    FROM firms WHERE workspace_id = p_workspace_id AND id = p_firm_id;

  -- Nothing unfinished and no card: there is nothing to say. A card is never created
  -- empty, so the list never shows a firm with no work on it.
  IF v_lane IS NULL AND NOT EXISTS (
    SELECT 1 FROM today_snapshots
     WHERE workspace_id = p_workspace_id AND snapshot_date = p_snapshot_date AND firm_id = p_firm_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO today_snapshots
    (workspace_id, snapshot_date, firm_id, lane, sort_at, assigned_user_id,
     open_items, replies_due, emails_due, calls_due)
  VALUES
    (p_workspace_id, p_snapshot_date, p_firm_id, COALESCE(v_lane, 'new_firm'),
     COALESCE(v_sort, now()), v_assignee, v_open, v_replies, v_emails, v_calls)
  ON CONFLICT ON CONSTRAINT today_snapshots_pkey DO UPDATE
     SET lane = COALESCE(v_lane, today_snapshots.lane),
         sort_at = COALESCE(v_sort, today_snapshots.sort_at),
         assigned_user_id = v_assignee,
         open_items = v_open,
         replies_due = v_replies,
         emails_due = v_emails,
         calls_due = v_calls,
         updated_at = greatest(now(), today_snapshots.built_at);
END
$today$;

-- Derived rows: the executions are the truth and the morning build recreates the
-- list. Each delete refreshes its card through the function above.
DELETE FROM today_items WHERE kind = 'linkedin_due';

ALTER TABLE today_snapshots DROP CONSTRAINT IF EXISTS today_snapshots_counts_nonnegative;
ALTER TABLE today_snapshots DROP COLUMN IF EXISTS linkedin_due;
ALTER TABLE today_snapshots
  ADD CONSTRAINT today_snapshots_counts_nonnegative
    CHECK (open_items >= 0 AND replies_due >= 0 AND emails_due >= 0 AND calls_due >= 0);

ALTER TABLE today_items DROP CONSTRAINT IF EXISTS today_items_kind_known;
ALTER TABLE today_items
  ADD CONSTRAINT today_items_kind_known
    CHECK (kind IN ('reply', 'callback', 'email_due', 'call_due', 'new_firm'));

-- IMMUTABLE and behind two generated columns and a CHECK. No stored row has the kind
-- whose arm goes (deleted above, refused by the CHECK above), so every stored lane is
-- still the one this body computes.
CREATE OR REPLACE FUNCTION today_lane_of_kind(kind text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE kind
           WHEN 'reply' THEN 'reply'
           WHEN 'callback' THEN 'callback'
           WHEN 'email_due' THEN 'due_work'
           WHEN 'call_due' THEN 'due_work'
           WHEN 'new_firm' THEN 'new_firm'
         END
$$;

-- ---------------------------------------------------------------------------
-- (g) The objects
--
-- `contacts.linkedin_url` and its shape CHECK, after (b) kept the URLs; the step
-- message with the three CHECKs over it, after (c); the recorded-results table with
-- its keys, index and grant. `DROP COLUMN` would take the CHECKs with it; they are
-- named so the file says what goes.
-- ---------------------------------------------------------------------------
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_linkedin_url_shape;
ALTER TABLE contacts DROP COLUMN IF EXISTS linkedin_url;

ALTER TABLE sequence_steps
  DROP CONSTRAINT IF EXISTS sequence_steps_linkedin_has_message,
  DROP CONSTRAINT IF EXISTS sequence_steps_linkedin_message_bounded,
  DROP CONSTRAINT IF EXISTS sequence_steps_no_unsubscribe_link;
ALTER TABLE sequence_steps DROP COLUMN IF EXISTS linkedin_message;

DROP TABLE IF EXISTS enrollment_linkedin_results;
