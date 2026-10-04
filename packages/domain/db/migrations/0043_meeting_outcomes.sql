-- Meeting-specific source revisions, analysis accounting and promise tasks. All paid settings default off.
ALTER TABLE meetings ADD COLUMN notes_revision integer NOT NULL DEFAULT 0 CHECK (notes_revision >= 0),
  ADD CONSTRAINT meetings_firm_identity UNIQUE (workspace_id,id,firm_id);
CREATE TABLE meeting_note_revisions (
  workspace_id uuid NOT NULL, meeting_id uuid NOT NULL, firm_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0), debrief text NOT NULL CHECK (octet_length(debrief) <= 32768),
  speaker_mappings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(speaker_mappings)='array' AND jsonb_array_length(speaker_mappings)<=200),
  item_overrides jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(item_overrides)='array' AND jsonb_array_length(item_overrides)<=100),
  sufficient boolean NOT NULL DEFAULT false, created_by_user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,meeting_id,revision),
  FOREIGN KEY(workspace_id,meeting_id,firm_id) REFERENCES meetings(workspace_id,id,firm_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY(workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
CREATE TABLE meeting_analyses (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), meeting_id uuid NOT NULL, firm_id uuid NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'), notes_revision integer NOT NULL CHECK(notes_revision >= 0),
  transcript_revision integer NOT NULL CHECK(transcript_revision >= 0), prompt_version integer NOT NULL CHECK(prompt_version > 0),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','stale','failed','held')),
  overview text NOT NULL DEFAULT '' CHECK(length(overview)<=6000),
  items jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)<=100),
  review_reasons jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(review_reasons)='array'),
  source_complete boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,meeting_id,source_hash,prompt_version),
  FOREIGN KEY(workspace_id,meeting_id,firm_id) REFERENCES meetings(workspace_id,id,firm_id) ON DELETE CASCADE ON UPDATE CASCADE
);
-- Request identity and attempt totals survive source deletion; content is scrubbed by deletion handling.
CREATE TABLE meeting_analysis_requests (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  meeting_id uuid, original_meeting_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  prompt_version integer NOT NULL CHECK(prompt_version > 0), model_name text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('extract','merge')),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','reserved','calling','ready','held','failed','estimated')),
  paid_attempts integer NOT NULL DEFAULT 0 CHECK(paid_attempts BETWEEN 0 AND 2), reservation_count integer NOT NULL DEFAULT 0 CHECK(reservation_count BETWEEN 0 AND 6),
  reservation_id uuid, result jsonb, reason text CHECK(reason ~ '^[a-z][a-z0-9_]{0,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(), next_wake_at timestamptz NOT NULL DEFAULT now(), deadline_at timestamptz,
  finished_at timestamptz, PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,original_meeting_id,request_hash,prompt_version,model_name),
  FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id) ON DELETE SET NULL (meeting_id),
  FOREIGN KEY(workspace_id,reservation_id) REFERENCES provider_reservations(workspace_id,id)
);
CREATE INDEX meeting_analysis_requests_due ON meeting_analysis_requests(next_wake_at,id) WHERE state IN ('queued','reserved','calling','held');
CREATE TABLE meeting_tasks (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), meeting_id uuid NOT NULL, firm_id uuid NOT NULL,
  commitment_id text NOT NULL CHECK(length(commitment_id) BETWEEN 1 AND 100), analysis_id uuid,
  label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 2000), owner_user_id uuid NOT NULL,
  deadline jsonb NOT NULL, due_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence) BETWEEN 1 AND 20),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')), version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  user_edited boolean NOT NULL DEFAULT false, creator_kind text NOT NULL DEFAULT 'system' CHECK(creator_kind='system'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,meeting_id,commitment_id),
  FOREIGN KEY(workspace_id,meeting_id,firm_id) REFERENCES meetings(workspace_id,id,firm_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY(workspace_id,analysis_id) REFERENCES meeting_analyses(workspace_id,id) ON DELETE SET NULL (analysis_id),
  FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
  CHECK((status='done') = (completed_at IS NOT NULL)),
  CONSTRAINT meeting_tasks_deadline_shape CHECK (jsonb_typeof(deadline)='object' AND deadline ? 'zone' AND
    ((deadline->>'precision'='date' AND deadline ? 'localDate' AND NOT deadline ? 'at') OR
     (deadline->>'precision'='instant' AND deadline ? 'at' AND NOT deadline ? 'localDate')))
);
CREATE INDEX meeting_tasks_open ON meeting_tasks(workspace_id,firm_id,due_at,id) WHERE status='open';
GRANT SELECT,INSERT,UPDATE,DELETE ON meeting_note_revisions,meeting_analyses,meeting_analysis_requests,meeting_tasks TO app_runtime,migration;
ALTER TABLE workspace_settings DROP CONSTRAINT workspace_settings_key_known,
 ADD CONSTRAINT workspace_settings_key_known
 CHECK (setting_key IN ('business_time_zone','postal_address','sending_enabled','calling_provider','calendar_integration',
 'telephony_budget','voicemail_script','call_transcription','monthly_cash_ceiling_cents','meeting_transcription','meeting_analysis'));
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
 ADD CONSTRAINT provider_reservations_subject_known CHECK(subject_kind IN ('research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis','meeting_transcription','meeting_analysis')),
 DROP CONSTRAINT provider_reservations_priced_shape,
 ADD CONSTRAINT provider_reservations_priced_shape CHECK (
 (subject_kind NOT IN ('research_run','reply_classification','call_summary','call_analysis','meeting_analysis') OR
 (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
 AND (subject_kind NOT IN ('call_session','call_transcription','meeting_transcription') OR
 (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL AND priced_unit='minute' AND priced_unit IS NOT NULL
 AND max_units IS NOT NULL AND max_units BETWEEN 1 AND 240 AND unit_price_micros IS NOT NULL AND unit_price_micros BETWEEN 0 AND 10000000)));
ALTER TABLE today_items DROP CONSTRAINT today_items_source_kind_known,
 ADD CONSTRAINT today_items_source_kind_known CHECK(source_kind IN ('callback','firm','reply_message','step_execution','call_task','meeting_task','meeting_review'));

-- A retained accounting identity must never retain or reacquire meeting text after deletion.
CREATE FUNCTION scrub_deleted_meeting_analysis_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.meeting_id IS NULL THEN NEW.result := NULL; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_analysis_result_deletion BEFORE INSERT OR UPDATE ON meeting_analysis_requests
  FOR EACH ROW EXECUTE FUNCTION scrub_deleted_meeting_analysis_result();
