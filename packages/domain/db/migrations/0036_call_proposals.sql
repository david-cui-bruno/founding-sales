-- ---------------------------------------------------------------------------
-- 0036_call_proposals.sql — call tasks, the pending-review hold and reached-person consent (slice 3a)
-- changes: today_items, active_holds, call_logs
--
-- Slice 3a, lane B (2 October 2026). A post-call analysis (0035) proposes; David applies a
-- proposal by clicking, for the first time, through an existing command. This file adds the
-- three things that path needs and the database did not have.
--
-- ## The new table
--
--   * `call_tasks` — a promise made on a call ("I'll send you the pricing sheet"), or the
--     "Send overview to <contact>" an overview request leaves when there is no send path. A
--     promise must outlive the daily Today snapshot, so it is a row of its own, and Today
--     reads the open ones as a source (kind `task`, source `call_task`).
--       - `quote_key` is `task:<first 16 hex of sha256(fold(quote))>`, the proposal's own key:
--         one spoken promise keeps one key across line shifts, splits and merges of the
--         transcript. UNIQUE `(workspace_id, call_session_id, quote_key)` makes a repeated
--         click on the same promise one task.
--       - `call_session_id` is SET NULL (that column only) when the call's session goes: the
--         promise stays David's work after the recording is deleted.
--       - `status` `open`, `done` or `cancelled`; `completed_at` exactly when `done`.
--     Classified `deletion_removes`: its text quotes a call.
--
-- ## What `-- changes:` names, and why
--
--   * `today_items` — `today_items_kind_known` admits `task` and `today_items_source_kind_known`
--     admits `call_task`. `today_lane_of_kind` gains `WHEN 'task' THEN 'due_work'`; every
--     other arm is 0018's, unchanged, so every stored lane (a generated column over it) is
--     still the one this body computes, and no stored row has the new kind.
--   * `active_holds` — `active_holds_recovery_action_known` admits `review_call`: the pending
--     hold's recovery is "review the call" (log it, or dismiss). Every stored value is still
--     admitted. The new partial unique index `active_holds_one_pending_review` allows one
--     `call_analysis_pending` hold per session, ever: a released one is never reopened.
--     No stored hold has that source kind, so it starts empty. No reason code is added:
--     the hold is a `scoped_pause`, which every installed firm page already parses.
--   * `call_logs` — `call_logs_agreement_needs_interest` is swapped under the **same name**
--     for a wider CHECK: an agreement comes from a reached, named person, and reached is
--     `interested`, `callback_requested`, `referral_or_wrong_person` or `not_interested`
--     ("call me Tuesday, and e-mail me the overview" is consent). The name now says less
--     than the CHECK; it is kept so the swap loses nothing (a rename would be a bare DROP).
--     Every stored agreement is on an `interested` log, which the new CHECK admits. No column.
--
-- ## Release shape
--
-- `touches-existing` for the constraint swaps, the function and the index; the table is new
-- and unreferenced by any deployed binary.
-- ---------------------------------------------------------------------------

CREATE TABLE call_tasks (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL,
  contact_id uuid,
  call_session_id uuid,
  quote_key text NOT NULL,
  text text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT call_tasks_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT call_tasks_one_per_quote UNIQUE (workspace_id, call_session_id, quote_key),
  CONSTRAINT call_tasks_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  -- The semantic composite key: a task at one firm never names a person at another, and a
  -- firm merge carries the task with its contact.
  CONSTRAINT call_tasks_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT call_tasks_session_fkey FOREIGN KEY (workspace_id, call_session_id)
    REFERENCES call_sessions (workspace_id, id) ON DELETE SET NULL (call_session_id),
  CONSTRAINT call_tasks_creator_fkey FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT call_tasks_quote_key_shape CHECK (quote_key ~ '^task:[0-9a-f]{16}$'),
  CONSTRAINT call_tasks_text_present CHECK (btrim(text) <> '' AND length(text) <= 300),
  CONSTRAINT call_tasks_status_known CHECK (status IN ('open', 'done', 'cancelled')),
  CONSTRAINT call_tasks_completion_consistent CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT call_tasks_updated_not_before_created CHECK (updated_at >= created_at)
);

CREATE INDEX call_tasks_open_by_firm ON call_tasks (workspace_id, firm_id) WHERE status = 'open';

GRANT SELECT, INSERT, UPDATE, DELETE ON call_tasks TO app_runtime, migration;

-- ---------------------------------------------------------------------------
-- today_items — the task kind and its source
-- ---------------------------------------------------------------------------
ALTER TABLE today_items DROP CONSTRAINT today_items_kind_known;
ALTER TABLE today_items
  ADD CONSTRAINT today_items_kind_known
    CHECK (kind IN ('reply', 'callback', 'email_due', 'call_due', 'new_firm', 'task'));

ALTER TABLE today_items DROP CONSTRAINT today_items_source_kind_known;
ALTER TABLE today_items
  ADD CONSTRAINT today_items_source_kind_known
    CHECK (source_kind IN ('callback', 'firm', 'reply_message', 'step_execution', 'call_task'));

-- IMMUTABLE and behind two generated columns and a CHECK. Every arm 0018 left is kept, word
-- for word; the one added arm is a kind no stored row has (refused by the CHECK until now).
CREATE OR REPLACE FUNCTION today_lane_of_kind(kind text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE kind
           WHEN 'reply' THEN 'reply'
           WHEN 'callback' THEN 'callback'
           WHEN 'email_due' THEN 'due_work'
           WHEN 'call_due' THEN 'due_work'
           WHEN 'new_firm' THEN 'new_firm'
           WHEN 'task' THEN 'due_work'
         END
$$;

-- ---------------------------------------------------------------------------
-- active_holds — the pending-review hold's recovery, and one per session ever
-- ---------------------------------------------------------------------------
ALTER TABLE active_holds DROP CONSTRAINT active_holds_recovery_action_known;
ALTER TABLE active_holds
  ADD CONSTRAINT active_holds_recovery_action_known
    CHECK (recovery_action IS NULL
           OR recovery_action IN ('resume_after_review', 'reconnect_mailbox', 'confirm_reply',
                                  'resolve_ambiguity', 'release_pause', 'mark_delivered_or_skipped',
                                  'requeue_job', 'advance_generation', 'review_call'));

CREATE UNIQUE INDEX active_holds_one_pending_review
  ON active_holds (workspace_id, source_event_id)
  WHERE source_event_kind = 'call_analysis_pending';

-- ---------------------------------------------------------------------------
-- call_logs — an agreement needs a reached person, not only an interested one
--
-- The old name, kept on purpose: despite "interest", the CHECK now admits any outcome that
-- says a person was reached (DESIGN-S3A §2.7). A same-name swap is a widening, not a drop.
-- ---------------------------------------------------------------------------
ALTER TABLE call_logs DROP CONSTRAINT call_logs_agreement_needs_interest;
ALTER TABLE call_logs
  ADD CONSTRAINT call_logs_agreement_needs_interest
    CHECK (agreed_follow_up IS NULL
           OR outcome IN ('interested', 'callback_requested', 'referral_or_wrong_person', 'not_interested'));
