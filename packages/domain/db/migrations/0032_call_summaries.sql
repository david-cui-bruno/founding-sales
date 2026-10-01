-- ---------------------------------------------------------------------------
-- 0032_call_summaries.sql — one summary per transcribed call (slice C3b)
-- changes: provider_reservations
--
-- After-call summaries (slice C3b, 1 October 2026). Once a recorded call has its transcript
-- (0030), the worker asks a model (Claude Haiku 4.5 by default) for a summary of three to six
-- sentences, up to five suggested next steps and the commitments heard, quoted, and stores the
-- answer here for the firm page and the Today card. Suggestions only: nothing is sent or
-- scheduled from them. The money is the paid-call pattern of `provider_reservations`, subject
-- `call_summary`, priced by model and tokens like a reply classification.
--
-- ## The new table
--
--   * `call_summaries` — one row per call session, primary key
--     `(workspace_id, call_session_id)`. `next_steps` is a JSON array of
--     `{ "action", "owner", "due" }` and `commitments` of `{ "speaker", "quote" }`. The
--     session's own foreign key, ON DELETE CASCADE, exactly as `call_transcripts`: a summary
--     quotes what the prospect said, personal data, classified `deletion_removes`.
--
-- ## What `-- changes:` names, and why
--
--   * `provider_reservations` — `provider_reservations_subject_known` admits `call_summary`
--     (subject id: the call session), `provider_reservations_priced_shape` gives it the LLM
--     shape research and the classifier have (a model and two token bounds, no unit), and the
--     new partial unique index `provider_reservations_one_open_summary` allows at most one
--     open (`reserved` or `calling`) reservation per call. Both CHECKs are swaps under the
--     same names as 0031's; every stored row keeps a subject the new CHECK admits and is
--     shaped exactly as before, and no stored row is a `call_summary`, so the index starts
--     empty.
--
-- ## Also: `transcription_provider_jobs` (slice C3a fix round, 1 October 2026)
--
--   * One row per provider-side transcription job (Amazon Transcribe), keyed by its job
--     name. Written and committed BEFORE `StartTranscriptionJob` (`submitting`), moved to
--     `started` in the commit right after it, and `collected` or `abandoned` once its result
--     is settled — so a crash or a lost lease after Start resumes polling the recorded job
--     instead of estimating it and buying another, and no poll runs inside a long
--     transaction. The same row records what is still owed to AWS: the input object and
--     the service-managed job (whose transcript AWS otherwise keeps for up to 90 days),
--     deleted by a retried sweep that marks each done.
--   * No foreign key to `call_sessions`, on purpose: the deletion workflow removes the
--     session, and the cleanup owed for it must outlive it. The row carries ids, a job
--     name and an object key, no prospect identity: `operational`.
--
-- ## Release shape
--
-- `touches-existing` for the constraint swaps and the index; both tables are new and
-- unreferenced by any deployed binary. Granted as `call_transcripts` is.
-- ---------------------------------------------------------------------------

CREATE TABLE call_summaries (
  workspace_id uuid NOT NULL,
  call_session_id uuid NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  summary text NOT NULL,
  next_steps jsonb NOT NULL,
  commitments jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_summaries_pkey PRIMARY KEY (workspace_id, call_session_id),
  CONSTRAINT call_summaries_session_fkey FOREIGN KEY (workspace_id, call_session_id)
    REFERENCES call_sessions (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT call_summaries_model_shape CHECK (model ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  CONSTRAINT call_summaries_prompt_version_shape CHECK (prompt_version ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  CONSTRAINT call_summaries_summary_length CHECK (char_length(summary) BETWEEN 1 AND 2000),
  CONSTRAINT call_summaries_next_steps_array CHECK (jsonb_typeof(next_steps) = 'array' AND jsonb_array_length(next_steps) <= 5),
  CONSTRAINT call_summaries_commitments_array CHECK (jsonb_typeof(commitments) = 'array' AND jsonb_array_length(commitments) <= 10)
);

-- ---------------------------------------------------------------------------
-- provider_reservations — the new subject
-- ---------------------------------------------------------------------------
ALTER TABLE provider_reservations
  DROP CONSTRAINT provider_reservations_subject_known,
  ADD CONSTRAINT provider_reservations_subject_known
    CHECK (subject_kind IN ('research_run', 'call_session', 'call_transcription', 'reply_classification', 'call_summary')),
  DROP CONSTRAINT provider_reservations_priced_shape,
  ADD CONSTRAINT provider_reservations_priced_shape
    CHECK (
      (subject_kind NOT IN ('research_run', 'reply_classification', 'call_summary')
        OR (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL
            AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
      AND
      (subject_kind NOT IN ('call_session', 'call_transcription')
        OR (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL
            AND priced_unit IS NOT NULL AND priced_unit = 'minute' AND max_units IS NOT NULL AND max_units > 0 AND max_units <= 240
            AND unit_price_micros IS NOT NULL AND unit_price_micros >= 0 AND unit_price_micros <= 10000000))
    );

CREATE UNIQUE INDEX provider_reservations_one_open_summary
  ON provider_reservations (workspace_id, subject_id)
  WHERE subject_kind = 'call_summary' AND state IN ('reserved', 'calling');

GRANT SELECT, INSERT, UPDATE, DELETE ON call_summaries TO app_runtime, migration;

-- ---------------------------------------------------------------------------
-- transcription_provider_jobs (slice C3a fix round)
-- ---------------------------------------------------------------------------
CREATE TABLE transcription_provider_jobs (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  job_name text NOT NULL,
  call_session_id uuid NOT NULL,
  attempt integer NOT NULL,
  reservation_id uuid NOT NULL,
  provider_key text NOT NULL,
  object_key text,
  state text NOT NULL DEFAULT 'submitting',
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  polls integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  job_deleted_at timestamptz,
  object_deleted_at timestamptz,
  cleanup_attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT transcription_provider_jobs_pkey PRIMARY KEY (workspace_id, job_name),
  CONSTRAINT transcription_provider_jobs_one_per_attempt UNIQUE (workspace_id, call_session_id, attempt),
  CONSTRAINT transcription_provider_jobs_job_name_shape CHECK (job_name ~ '^[0-9A-Za-z._-]{1,200}$'),
  CONSTRAINT transcription_provider_jobs_provider_key_shape CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT transcription_provider_jobs_object_key_shape CHECK (object_key IS NULL OR (object_key ~ '^[0-9A-Za-z/._-]+$' AND char_length(object_key) <= 512)),
  CONSTRAINT transcription_provider_jobs_attempt_positive CHECK (attempt >= 1),
  CONSTRAINT transcription_provider_jobs_state_known CHECK (state IN ('submitting', 'started', 'collected', 'abandoned')),
  CONSTRAINT transcription_provider_jobs_counts_nonnegative CHECK (polls >= 0 AND cleanup_attempts >= 0),
  CONSTRAINT transcription_provider_jobs_finished_consistent
    CHECK ((state IN ('collected', 'abandoned')) = (finished_at IS NOT NULL))
);

-- The collect and cleanup source's question: what is due now.
CREATE INDEX transcription_provider_jobs_due
  ON transcription_provider_jobs (next_poll_at)
  WHERE state IN ('submitting', 'started') OR job_deleted_at IS NULL OR object_deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON transcription_provider_jobs TO app_runtime, migration;
