-- ---------------------------------------------------------------------------
-- 0039_meeting_attendance.sql — attendance is confirmed, not assumed (lane M1)
-- changes: meetings, funnel_facts, audit_events
--
-- Cal.com's `MEETING_ENDED` fires at a booking's SCHEDULED end, so it says nothing about
-- who came. Until now it made a meeting `held` and wrote the funnel fact `meeting.held`
-- (`meetings/calcom.ts`), and the hourly reconciliation synthesized the same event for
-- every past accepted booking (`meetings/reconcile.ts`). No person could set `held` or
-- `no_show`. David's decision (3 October 2026): attendance must be confirmed.
--
-- ## States
--
--   * `ended` (new) — the scheduled end passed; attendance is not confirmed. What
--     `MEETING_ENDED` produces from now on, from the webhook and the reconciliation alike.
--   * `held` — confirmed attendance only: a person's confirmation (or, later, a recording).
--   * `no_show` — confirmed absence: Cal.com's no-show flag, or a person.
--   * `state_before_no_show` may be `ended`; it is never `held` any more (a no-show is
--     never recorded over a confirmed attendance by Cal.com, and a person's no-show over
--     their own `held` remembers `ended`).
--
-- ## Attendance columns
--
--   * `attendance_source` — `manual`, `calcom_no_show` or `recording`; null while
--     unconfirmed. `held` is `manual` or `recording`; `no_show` is `manual` or
--     `calcom_no_show` (a missing recording is not a no-show).
--   * `attendance_confirmed_at` — when it was confirmed; set exactly when the source is.
--   * `attendance_confirmed_by` — the member who confirmed it; set exactly for `manual`.
--
-- ## Withdrawn funnel facts
--
-- `funnel_facts` stays append-only: DELETE and TRUNCATE stay revoked (0022). A fact that
-- turns out to be wrong is WITHDRAWN instead: `withdrawn_at` and `withdrawn_reason` (a
-- code) are set, and every reader skips it. UPDATE is granted on those two columns and on
-- `detail` (0022), and on nothing else. A withdrawn fact keeps its dedupe key, so a later
-- confirmation reinstates the same row (clears the two columns) rather than inserting a
-- second; it keeps the actor it was first written with.
--
-- ## The historical correction
--
-- Every stored `held` came from the scheduled end — no person could set one — so:
--
--   * `held` → `ended`, and `state_before_no_show = 'held'` → `ended`;
--   * every stored `no_show` came from Cal.com's flag: its source is `calcom_no_show`,
--     confirmed at the meeting's `last_event_at`, by nobody;
--   * every `meeting.held` fact is withdrawn with the reason `scheduled_end_not_attendance`
--     and re-dated to its meeting's start (where the meeting still exists), the instant a
--     confirmation dates it at, so a confirmation that reinstates it counts it on the
--     meeting's own day;
--   * one `meeting.attendance_corrected` audit row per workspace that had anything to
--     correct, with the four counts;
--   * `calcom_events`, the delivery log, is history and is left as it is.
--
-- ## Release shape
--
-- Touches existing rows and narrows a CHECK (`held` is no longer a `state_before_no_show`),
-- so an older binary that writes `held` from `MEETING_ENDED` is refused: the release stops
-- the services, migrates and starts the new ones (REQUIRED_SCHEMA 39). The desktop that
-- reads `ended` was released first (lane M1, B0).
-- ---------------------------------------------------------------------------

-- ---- (a) meetings: the old checks go first, so the correction can write `ended` ----
ALTER TABLE meetings
  DROP CONSTRAINT meetings_state_known,
  DROP CONSTRAINT meetings_no_show_remembers,
  ADD COLUMN attendance_source text,
  ADD COLUMN attendance_confirmed_at timestamptz,
  ADD COLUMN attendance_confirmed_by uuid;

-- ---- (b) funnel_facts: the withdrawal marker -----------------------------------------
ALTER TABLE funnel_facts
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_reason text,
  ADD CONSTRAINT funnel_facts_withdrawal_consistent CHECK ((withdrawn_at IS NULL) = (withdrawn_reason IS NULL)),
  ADD CONSTRAINT funnel_facts_withdrawn_reason_shape
    CHECK (withdrawn_reason IS NULL OR (withdrawn_reason ~ '^[a-z][a-z0-9_]*$' AND length(withdrawn_reason) <= 64));

-- ---- (c) the correction ------------------------------------------------------------
-- The audit row first, so its counts are of the rows as they stood before the correction.
INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind, subject_id, detail)
SELECT counted.workspace_id, 'system', 'meeting.attendance_corrected', 'workspace', counted.workspace_id::text,
       jsonb_build_object(
         'migration', '0039',
         'heldToEnded', counted.held_to_ended,
         'noShowBeforeHeldToEnded', counted.no_show_before_held,
         'noShowsAttributedToCalcom', counted.no_shows_from_calcom,
         'heldFactsWithdrawn', counted.held_facts_withdrawn,
         'withdrawnReason', 'scheduled_end_not_attendance')
  FROM (
    SELECT w.id AS workspace_id,
           (SELECT count(*) FROM meetings m WHERE m.workspace_id = w.id AND m.state = 'held') AS held_to_ended,
           (SELECT count(*) FROM meetings m WHERE m.workspace_id = w.id AND m.state_before_no_show = 'held') AS no_show_before_held,
           (SELECT count(*) FROM meetings m WHERE m.workspace_id = w.id AND m.state = 'no_show') AS no_shows_from_calcom,
           (SELECT count(*) FROM funnel_facts f WHERE f.workspace_id = w.id AND f.kind = 'meeting.held') AS held_facts_withdrawn
      FROM workspaces w
  ) AS counted
 WHERE counted.held_to_ended + counted.no_show_before_held + counted.no_shows_from_calcom + counted.held_facts_withdrawn > 0;

UPDATE meetings SET state = 'ended' WHERE state = 'held';
UPDATE meetings SET state_before_no_show = 'ended' WHERE state_before_no_show = 'held';
UPDATE meetings
   SET attendance_source = 'calcom_no_show', attendance_confirmed_at = last_event_at
 WHERE state = 'no_show';

-- Re-dated to the meeting's start through the uid it was keyed by (the meeting's original
-- booking uid; `meeting_booking_uids` resolves every uid a meeting has had).
UPDATE funnel_facts f
   SET occurred_at = m.starts_at
  FROM meeting_booking_uids u
  JOIN meetings m ON m.workspace_id = u.workspace_id AND m.id = u.meeting_id
 WHERE f.kind = 'meeting.held'
   AND u.workspace_id = f.workspace_id AND u.booking_uid = f.dedupe_key;

UPDATE funnel_facts
   SET withdrawn_at = now(), withdrawn_reason = 'scheduled_end_not_attendance'
 WHERE kind = 'meeting.held' AND withdrawn_at IS NULL;

-- ---- (d) the new checks ---------------------------------------------------------------
ALTER TABLE meetings
  ADD CONSTRAINT meetings_state_known
    CHECK (state IN ('booked', 'rescheduled', 'cancelled', 'ended', 'held', 'no_show')),
  ADD CONSTRAINT meetings_no_show_remembers
    CHECK ((state = 'no_show') = (state_before_no_show IS NOT NULL)
           AND (state_before_no_show IS NULL OR state_before_no_show IN ('booked', 'rescheduled', 'ended'))),
  -- Confirmed exactly when the state is a confirmation, and by a source that can say it:
  -- attendance by a person or a recording, absence by a person or Cal.com's flag. (So the
  -- source is always one of `manual`, `calcom_no_show`, `recording`: no separate list.)
  ADD CONSTRAINT meetings_attendance_confirmed
    CHECK ((state IN ('held', 'no_show')) = (attendance_source IS NOT NULL)
           AND (attendance_source IS NULL) = (attendance_confirmed_at IS NULL)
           AND (state <> 'held' OR attendance_source IN ('manual', 'recording'))
           AND (state <> 'no_show' OR attendance_source IN ('manual', 'calcom_no_show'))),
  -- A person's confirmation names the person; nothing else names anyone. (`IS NOT
  -- DISTINCT FROM`: a null source compared with `=` would let a CHECK pass on NULL.)
  ADD CONSTRAINT meetings_attendance_confirmer
    CHECK ((attendance_source IS NOT DISTINCT FROM 'manual') = (attendance_confirmed_by IS NOT NULL)),
  ADD CONSTRAINT meetings_attendance_confirmer_fkey FOREIGN KEY (workspace_id, attendance_confirmed_by)
    REFERENCES workspace_memberships (workspace_id, user_id);

-- ---- (e) privileges ---------------------------------------------------------------------
-- The withdrawal is the second column-level UPDATE on funnel_facts, beside 0022's
-- `detail`. Nothing else in the row may change, and nothing may remove it.
GRANT UPDATE (withdrawn_at, withdrawn_reason) ON funnel_facts TO app_runtime, migration;
