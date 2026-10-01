-- ---------------------------------------------------------------------------
-- 0029_meeting_booking_uids.sql — every Cal.com booking uid a meeting has been
-- changes: none
--
-- Cal.com slice M1, review fold 2 (30 September 2026). A Cal.com reschedule issues a
-- new booking uid and cancels the old one, so one meeting is a chain of uids
-- A → B → C. `meetings` stores two of them (`booking_uid`, the one it began as, and
-- `current_booking_uid`, the one it is now), and an intermediate B was lost as soon as
-- the chain grew past two: a late delivery about B found no meeting and booked a
-- second one. This table holds **every** uid the webhook or the reconciliation has
-- learned for a meeting, and resolution goes through it.
--
--   * `(workspace_id, booking_uid)` is the primary key: one uid is one meeting.
--   * `meeting_id` references the meeting with ON DELETE CASCADE, so a meeting that is
--     deleted — by the deletion workflow, or folded into another after its aliases were
--     moved — takes its uids with it. A uid is a Cal.com identifier, not personal data.
--   * Backfilled from both uid columns of every meeting that exists, so the table is
--     complete the moment this migration commits.
--
-- New table, unreferenced by any deployed binary, so `changes: none`; the backfill
-- reads `meetings` and writes only this table. Granted as `meetings` is.
-- ---------------------------------------------------------------------------
CREATE TABLE meeting_booking_uids (
  workspace_id uuid NOT NULL,
  booking_uid text NOT NULL,
  meeting_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_booking_uids_pkey PRIMARY KEY (workspace_id, booking_uid),
  CONSTRAINT meeting_booking_uids_meeting_fkey FOREIGN KEY (workspace_id, meeting_id)
    REFERENCES meetings (workspace_id, id) ON DELETE CASCADE,
  -- The spelling `meetings_uid_shape` holds both uid columns to.
  CONSTRAINT meeting_booking_uids_uid_shape CHECK (booking_uid ~ '^[A-Za-z0-9_-]{1,128}$')
);

-- A meeting's uids, for the fold that moves them.
CREATE INDEX meeting_booking_uids_by_meeting ON meeting_booking_uids (workspace_id, meeting_id);

INSERT INTO meeting_booking_uids (workspace_id, booking_uid, meeting_id, created_at)
SELECT workspace_id, booking_uid, id, created_at FROM meetings
UNION
SELECT workspace_id, current_booking_uid, id, created_at FROM meetings
ON CONFLICT (workspace_id, booking_uid) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_booking_uids TO app_runtime, migration;
