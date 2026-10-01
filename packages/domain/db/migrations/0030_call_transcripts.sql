-- ---------------------------------------------------------------------------
-- 0030_call_transcripts.sql — one transcript per answered, recorded call (slice C2)
-- changes: workspace_settings
--
-- Call transcription (slice C2, 30 September 2026). After a connected call of at least
-- twenty seconds the worker sends its recording to the transcription provider
-- (Deepgram Nova-3, pre-recorded, `mip_opt_out=true`) and stores what came back here,
-- with two speakers, for the firm page's call history. The money is the paid-call
-- pattern of `provider_reservations` (subject `call_transcription`, which 0028 already
-- admits, priced by the minute), against its own daily ceiling.
--
-- ## The new table
--
--   * `call_transcripts` — one row per call session, primary key
--     `(workspace_id, call_session_id)`. `utterances` is a JSON array of
--     `{ "speaker", "start", "end", "text" }` (speaker index from 0, seconds from the
--     start of the recording). The session's own foreign key, ON DELETE CASCADE, so a
--     session the deletion workflow removes takes its transcript with it: a transcript
--     is what the prospect said, personal data, classified `deletion_removes`.
--
-- ## What `-- changes:` names, and why
--
--   * `workspace_settings` — `workspace_settings_key_known` admits the new key
--     `call_transcription` (`{ enabled, dailyCeilingCents, unitPriceMicros }`), a swap
--     under the same name as 0020's and 0028's were. No row is written: a key with no
--     row is its default, and the default is off. Every stored row keeps a key the new
--     CHECK admits, so every existing answer is unchanged.
--
-- ## Release shape
--
-- `touches-existing` for the constraint swap; the table is new and unreferenced by any
-- deployed binary. Granted as `call_sessions` is.
-- ---------------------------------------------------------------------------

CREATE TABLE call_transcripts (
  workspace_id uuid NOT NULL,
  call_session_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  language text NOT NULL,
  duration_seconds integer NOT NULL,
  utterances jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_transcripts_pkey PRIMARY KEY (workspace_id, call_session_id),
  CONSTRAINT call_transcripts_session_fkey FOREIGN KEY (workspace_id, call_session_id)
    REFERENCES call_sessions (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT call_transcripts_provider_shape CHECK (provider ~ '^[a-z][a-z0-9_.-]{1,31}$'),
  CONSTRAINT call_transcripts_model_shape CHECK (model ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  CONSTRAINT call_transcripts_language_shape CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  CONSTRAINT call_transcripts_duration_range CHECK (duration_seconds >= 0 AND duration_seconds <= 86400),
  CONSTRAINT call_transcripts_utterances_array CHECK (jsonb_typeof(utterances) = 'array')
);

-- ---------------------------------------------------------------------------
-- workspace_settings — the new key
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_settings
  DROP CONSTRAINT workspace_settings_key_known,
  ADD CONSTRAINT workspace_settings_key_known
    CHECK (setting_key IN ('business_time_zone', 'postal_address', 'sending_enabled',
                           'calling_provider', 'calendar_integration', 'telephony_budget',
                           'voicemail_script', 'call_transcription'));

GRANT SELECT, INSERT, UPDATE, DELETE ON call_transcripts TO app_runtime, migration;
