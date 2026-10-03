-- ---------------------------------------------------------------------------
-- 0041_meeting_recordings.sql — a demo's uploaded audio files (lane M4)
-- changes: (none; one new table)
--
-- David's directive of 3 October 2026: Zoom records each Callie demo LOCALLY, with one
-- audio file per participant, into ~/Movies/Callie Demos. The Mac watches that folder,
-- keeps every recording that overlaps no Callie meeting out (never uploaded, never shown),
-- matches the rest to a meeting or asks David, and uploads each per-participant AUDIO file
-- (never video) to the call-audio bucket under `meetings/<meeting>/<sha256>.m4a`, where the
-- bucket's one-day expiry removes it (E4, E5). This table is the record of each file that
-- arrived.
--
-- ## The table
--
--   * `meeting_recordings` — one row per uploaded file.
--       - `meeting_id` — the meeting it belongs to. ON DELETE CASCADE: retention follows the
--         meeting, so a deletion that takes the meeting takes its recordings' rows (the
--         objects expire with the bucket's lifecycle). A Cal.com fold moves them to the
--         surviving meeting first (`meetings/calcom.ts`).
--       - `segment` — the file's place in its participant's recording, from 1 (a pause or a
--         stop and start makes more than one).
--       - `participant_label` — the file's name as Zoom wrote it: metadata, never content.
--       - `sha256`, `size_bytes` — the bytes S3 verified (the presigned PUT binds both), at
--         most 300 MB.
--       - `s3_key` — `meetings/<meeting>/<sha256>.m4a`, where the file was uploaded: its own
--         digest (a CHECK), under the meeting it was uploaded for. A fold that moves the row to
--         the surviving meeting keeps the key, because the object stays where it is.
--       - `state` — `uploaded` when registered; M5's `meeting.transcribe` job moves it to
--         `transcribing`, `transcribed` or `failed`. Nothing is enqueued yet.
--     Unique on (workspace, meeting, sha256): registering a file twice — a duplicate
--     discovery, a restart, a replay — records it once.
--
-- ## Release shape
--
-- `additive`: a new table no deployed binary references.
-- ---------------------------------------------------------------------------

CREATE TABLE meeting_recordings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  meeting_id uuid NOT NULL,
  segment integer NOT NULL,
  participant_label text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  s3_key text NOT NULL,
  state text NOT NULL DEFAULT 'uploaded',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_recordings_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT meeting_recordings_once UNIQUE (workspace_id, meeting_id, sha256),
  CONSTRAINT meeting_recordings_meeting_fkey FOREIGN KEY (workspace_id, meeting_id)
    REFERENCES meetings (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_recordings_segment_bounded CHECK (segment BETWEEN 1 AND 1000),
  CONSTRAINT meeting_recordings_label_bounded
    CHECK (char_length(participant_label) BETWEEN 1 AND 200 AND participant_label !~ '[[:cntrl:]]'),
  CONSTRAINT meeting_recordings_sha256_shape CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT meeting_recordings_size_bounded CHECK (size_bytes BETWEEN 1 AND 314572800),
  CONSTRAINT meeting_recordings_key_shape
    CHECK (s3_key ~ ('^meetings/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' || sha256 || '\.m4a$')),
  CONSTRAINT meeting_recordings_state_known CHECK (state IN ('uploaded', 'transcribing', 'transcribed', 'failed'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_recordings TO app_runtime, migration;
