-- 0042_meeting_transcription.sql — attributed demo transcripts and bounded processing.
-- changes: meetings, meeting_recordings, provider_reservations, workspace_settings
-- Existing response shapes and recording states stay compatible. Settings default off.
ALTER TABLE meetings ADD COLUMN transcript_source_revision integer NOT NULL DEFAULT 0 CHECK (transcript_source_revision >= 0);
ALTER TABLE meeting_recordings
  ADD COLUMN source_kind text NOT NULL DEFAULT 'unknown' CHECK (source_kind IN ('participant','mixed','unknown')),
  ADD COLUMN processing_status text NOT NULL DEFAULT 'queued' CHECK (processing_status IN
    ('queued','preparing','transcribing','ready','needs_reupload','failed','budget_held','funding_unverified','disabled')),
  ADD COLUMN processing_reason text CHECK (processing_reason ~ '^[a-z][a-z0-9_]{0,79}$'),
  ADD COLUMN duration_ms integer CHECK (duration_ms BETWEEN 0 AND 14400000),
  ADD COLUMN processing_settings_version integer NOT NULL DEFAULT 0 CHECK (processing_settings_version >= 0),
  ADD COLUMN wake_revision integer NOT NULL DEFAULT 0 CHECK (wake_revision >= 0),
  ADD COLUMN next_wake_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX meeting_recordings_processing_due ON meeting_recordings(next_wake_at,id) WHERE processing_status IN ('queued','preparing','disabled','budget_held','funding_unverified');

CREATE TABLE meeting_recording_aliases (
  workspace_id uuid NOT NULL, alias_id uuid NOT NULL, recording_id uuid NOT NULL,
  PRIMARY KEY (workspace_id,alias_id),
  FOREIGN KEY (workspace_id,recording_id) REFERENCES meeting_recordings(workspace_id,id) ON DELETE CASCADE,
  CHECK (alias_id <> recording_id)
);
CREATE INDEX meeting_recording_aliases_target ON meeting_recording_aliases(workspace_id,recording_id);

CREATE TABLE meeting_transcripts (
  id uuid NOT NULL DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL, original_recording_id uuid NOT NULL, version integer NOT NULL CHECK (version > 0),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 0 AND 14400000),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  utterances jsonb NOT NULL CHECK (jsonb_typeof(utterances)='array' AND jsonb_array_length(utterances)<=20000 AND octet_length(utterances::text)<=4194304),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id), UNIQUE (workspace_id,original_recording_id,version),
  FOREIGN KEY (workspace_id,recording_id) REFERENCES meeting_recordings(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX meeting_transcripts_recording ON meeting_transcripts(workspace_id,recording_id,created_at,id);

-- Operational only; survives subject deletion to collect/settle an already paid job.
-- No participant labels, transcript text, or source digest. recording_id is cleared by deletion.
CREATE TABLE meeting_transcription_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id),
  recording_id uuid, original_recording_id uuid NOT NULL,
  reservation_id uuid NOT NULL, job_name text NOT NULL CHECK (job_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  input_key text NOT NULL CHECK (input_key ~ '^meetings-processing/[0-9a-f-]+/[0-9a-f-]+[.]flac$'),
  output_key text NOT NULL CHECK (output_key ~ '^meetings-processing/[0-9a-f-]+/[0-9a-f-]+[.]json$'),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 1 AND 14400000),
  source_kind text NOT NULL CHECK (source_kind IN ('participant','mixed','unknown')),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','submitting','started','complete','failed','estimated','released')),
  next_check_at timestamptz NOT NULL DEFAULT now(), deadline_at timestamptz NOT NULL,
  looks integer NOT NULL DEFAULT 0 CHECK (looks >= 0), reason text CHECK (reason ~ '^[a-z][a-z0-9_]{0,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  PRIMARY KEY (workspace_id,id), UNIQUE (workspace_id,reservation_id), UNIQUE (job_name),
  FOREIGN KEY (workspace_id,recording_id) REFERENCES meeting_recordings(workspace_id,id) ON DELETE SET NULL (recording_id),
  FOREIGN KEY (workspace_id,reservation_id) REFERENCES provider_reservations(workspace_id,id),
  CHECK ((state IN ('complete','failed','estimated','released')) = (finished_at IS NOT NULL)),
  CHECK (deadline_at >= created_at)
);
CREATE INDEX meeting_transcription_attempts_due ON meeting_transcription_attempts(next_check_at) WHERE state IN ('reserved','submitting','started');
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_recording_aliases, meeting_transcripts, meeting_transcription_attempts TO app_runtime, migration;

ALTER TABLE workspace_settings DROP CONSTRAINT workspace_settings_key_known,
  ADD CONSTRAINT workspace_settings_key_known
  CHECK (setting_key IN ('business_time_zone','postal_address','sending_enabled',
    'calling_provider','calendar_integration','telephony_budget','voicemail_script','call_transcription','monthly_cash_ceiling_cents','meeting_transcription'));
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
  ADD CONSTRAINT provider_reservations_subject_known CHECK (subject_kind IN
    ('research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis','meeting_transcription')),
  DROP CONSTRAINT provider_reservations_priced_shape,
  ADD CONSTRAINT provider_reservations_priced_shape CHECK (
    (subject_kind NOT IN ('research_run','reply_classification','call_summary','call_analysis') OR
      (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
    AND (subject_kind NOT IN ('call_session','call_transcription','meeting_transcription') OR
      (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL AND priced_unit='minute' AND priced_unit IS NOT NULL
       AND max_units IS NOT NULL AND max_units BETWEEN 1 AND 240 AND unit_price_micros IS NOT NULL AND unit_price_micros BETWEEN 0 AND 10000000)));
