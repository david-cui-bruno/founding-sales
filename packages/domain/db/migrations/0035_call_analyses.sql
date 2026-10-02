-- ---------------------------------------------------------------------------
-- 0035_call_analyses.sql — one validated, versioned analysis per call version (slice 3a)
-- changes: provider_reservations
--
-- Post-call analysis (slice 3a, 1 October 2026). Once a recorded call has a channel-labelled
-- transcript, the worker asks a model (Claude Haiku 4.5 on Bedrock) for one structured
-- reading of the call (`call_analysis.1`), checks it against the transcript, and stores it as
-- one version here with the proposal set the pure policy computed from it and that set's
-- hash. Nothing in a row acts: every proposal is applied only by David's click, which is
-- checked against one exact version and its stored hash.
--
-- ## The new table
--
--   * `call_analyses` — one row per **version**, key `(workspace_id, id)`, versions numbered
--     per call from 1 (`call_analyses_one_version`). A reanalysis is a new version, so a
--     click can be refused by version.
--       - `origin` `model`: a model reading. `state` `pending` until the paid call ends, then
--         `completed` (with `result`, `proposals`, `proposal_hash`) or `failed` (with
--         `failure_reason`). `model`, `prompt_version`, `schema_version`, `policy_version` and
--         `transcript_sha256` (the revision of the transcript it read; `call_transcripts` has
--         none of its own) are required.
--       - `origin` `user`: David's edited notes, in `notes` (`{ summary, facts[] }`), always
--         `completed`, with the editor in `requested_by_user_id`. The current notes are the
--         latest user version, otherwise the latest completed model version.
--     At most one `pending` row per call (`call_analyses_one_pending`). The session's own
--     foreign key, ON DELETE CASCADE, as `call_transcripts` and `call_summaries`: a result
--     quotes what the prospect said, personal data, classified `deletion_removes`.
--
-- ## What `-- changes:` names, and why
--
--   * `provider_reservations` — `provider_reservations_subject_known` admits `call_analysis`
--     (subject id: the analysis version), `provider_reservations_priced_shape` gives it the
--     LLM shape (a model and two token bounds, no unit), and the new partial unique index
--     `provider_reservations_one_open_analysis` allows at most one open (`reserved` or
--     `calling`) reservation per version. Both CHECKs are swaps under the same names as
--     0032's; every stored row keeps a subject the new CHECK admits and is shaped exactly as
--     before, and no stored row is a `call_analysis`, so the index starts empty.
--
-- ## Release shape
--
-- `touches-existing` for the constraint swaps and the index; the table is new and
-- unreferenced by any deployed binary. Granted as `call_summaries` is.
-- ---------------------------------------------------------------------------

CREATE TABLE call_analyses (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  call_session_id uuid NOT NULL,
  version integer NOT NULL,
  origin text NOT NULL,
  requested_reason text NOT NULL,
  requested_by_user_id uuid,
  transcript_sha256 text,
  model text,
  prompt_version text,
  schema_version text,
  policy_version text,
  state text NOT NULL,
  failure_reason text,
  result jsonb,
  notes jsonb,
  proposals jsonb,
  proposal_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT call_analyses_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT call_analyses_id_unique UNIQUE (id),
  CONSTRAINT call_analyses_one_version UNIQUE (workspace_id, call_session_id, version),
  CONSTRAINT call_analyses_session_fkey FOREIGN KEY (workspace_id, call_session_id)
    REFERENCES call_sessions (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT call_analyses_requester_fkey FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT call_analyses_version_positive CHECK (version >= 1),
  CONSTRAINT call_analyses_origin_known CHECK (origin IN ('model', 'user')),
  CONSTRAINT call_analyses_reason_known CHECK (requested_reason IN ('transcript', 'retry', 'reanalysis', 'user_edit')),
  CONSTRAINT call_analyses_state_known CHECK (state IN ('pending', 'completed', 'failed')),
  CONSTRAINT call_analyses_failure_known
    CHECK (failure_reason IS NULL OR failure_reason IN ('malformed', 'schema_invalid', 'refused', 'provider_error',
      'transcript_changed', 'transcript_missing', 'transcript_too_long', 'not_channel_labelled', 'budget_exhausted', 'off')),
  CONSTRAINT call_analyses_transcript_sha256_shape CHECK (transcript_sha256 IS NULL OR transcript_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT call_analyses_proposal_hash_shape CHECK (proposal_hash IS NULL OR proposal_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT call_analyses_model_shape CHECK (model IS NULL OR model ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  CONSTRAINT call_analyses_versions_shape
    CHECK ((prompt_version IS NULL OR prompt_version ~ '^[a-z0-9][a-z0-9_.-]{0,63}$')
       AND (schema_version IS NULL OR schema_version ~ '^[a-z0-9][a-z0-9_.-]{0,63}$')
       AND (policy_version IS NULL OR policy_version ~ '^[a-z0-9][a-z0-9_.-]{0,63}$')),
  CONSTRAINT call_analyses_json_shape
    CHECK ((result IS NULL OR jsonb_typeof(result) = 'object')
       AND (notes IS NULL OR jsonb_typeof(notes) = 'object')
       AND (proposals IS NULL OR (jsonb_typeof(proposals) = 'array' AND jsonb_array_length(proposals) <= 40))),
  -- A user version: David's notes, complete when written, never a model's fields.
  CONSTRAINT call_analyses_user_shape
    CHECK (origin <> 'user' OR (
      requested_reason = 'user_edit' AND requested_by_user_id IS NOT NULL AND state = 'completed'
      AND notes IS NOT NULL AND result IS NULL AND proposals IS NULL AND proposal_hash IS NULL
      AND model IS NULL AND prompt_version IS NULL AND schema_version IS NULL AND policy_version IS NULL
      AND failure_reason IS NULL AND completed_at IS NOT NULL)),
  -- A model version: what produced it is always named; no notes of its own.
  CONSTRAINT call_analyses_model_required
    CHECK (origin <> 'model' OR (
      requested_reason <> 'user_edit' AND notes IS NULL AND transcript_sha256 IS NOT NULL
      AND model IS NOT NULL AND prompt_version IS NOT NULL AND schema_version IS NOT NULL AND policy_version IS NOT NULL)),
  -- Each state carries exactly its own fields.
  CONSTRAINT call_analyses_state_shape
    CHECK (
      (state = 'pending' AND result IS NULL AND proposals IS NULL AND proposal_hash IS NULL
        AND failure_reason IS NULL AND completed_at IS NULL)
      OR (state = 'completed' AND failure_reason IS NULL AND completed_at IS NOT NULL
        AND (origin = 'user' OR (result IS NOT NULL AND proposals IS NOT NULL AND proposal_hash IS NOT NULL)))
      OR (state = 'failed' AND origin = 'model' AND failure_reason IS NOT NULL AND completed_at IS NOT NULL
        AND result IS NULL AND proposals IS NULL AND proposal_hash IS NULL))
);

-- At most one model version is being produced for a call at a time.
CREATE UNIQUE INDEX call_analyses_one_pending
  ON call_analyses (workspace_id, call_session_id)
  WHERE state = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON call_analyses TO app_runtime, migration;

-- ---------------------------------------------------------------------------
-- provider_reservations — the new subject
-- ---------------------------------------------------------------------------
ALTER TABLE provider_reservations
  DROP CONSTRAINT provider_reservations_subject_known,
  ADD CONSTRAINT provider_reservations_subject_known
    CHECK (subject_kind IN ('research_run', 'call_session', 'call_transcription', 'reply_classification', 'call_summary',
                            'call_analysis')),
  DROP CONSTRAINT provider_reservations_priced_shape,
  ADD CONSTRAINT provider_reservations_priced_shape
    CHECK (
      (subject_kind NOT IN ('research_run', 'reply_classification', 'call_summary', 'call_analysis')
        OR (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL
            AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
      AND
      (subject_kind NOT IN ('call_session', 'call_transcription')
        OR (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL
            AND priced_unit IS NOT NULL AND priced_unit = 'minute' AND max_units IS NOT NULL AND max_units > 0 AND max_units <= 240
            AND unit_price_micros IS NOT NULL AND unit_price_micros >= 0 AND unit_price_micros <= 10000000))
    );

CREATE UNIQUE INDEX provider_reservations_one_open_analysis
  ON provider_reservations (workspace_id, subject_id)
  WHERE subject_kind = 'call_analysis' AND state IN ('reserved', 'calling');
