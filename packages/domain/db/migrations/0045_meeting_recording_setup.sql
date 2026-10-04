-- changes: jobs, workspace_settings
-- First claim survives lease recovery. Existing jobs acquire it only on their next claim.
ALTER TABLE jobs ADD COLUMN first_claimed_at timestamptz;
ALTER TABLE workspace_settings DROP CONSTRAINT workspace_settings_key_known,
  ADD CONSTRAINT workspace_settings_key_known CHECK(setting_key IN
  ('business_time_zone','postal_address','sending_enabled','calling_provider','calendar_integration','telephony_budget','voicemail_script','call_transcription','monthly_cash_ceiling_cents','meeting_transcription','meeting_analysis','meeting_follow_through','meeting_auto_recording'));
CREATE TABLE meeting_recording_setup (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL, target jsonb NOT NULL CHECK(jsonb_typeof(target)='object'),
  target_hash text NOT NULL CHECK(target_hash ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), retry_generation integer NOT NULL DEFAULT 0 CHECK(retry_generation>=0),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verifying','ready','manual','obsolete')),
  reason text CHECK(reason IN ('disabled','unconfigured','routing_ambiguous','unmatched','not_future','expired','attempt_limit','booking_mismatch','zoom_mismatch','unsupported_meeting','unsupported_recording_mode','provider_refused','provider_unreachable','auth_failed','rate_limited','ambiguous_write','target_changed','manual_override')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
  first_attempt_at timestamptz, deadline_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  write_intent_at timestamptz, write_owner_token bigint, write_job_id uuid,
  write_certainty text NOT NULL DEFAULT 'none' CHECK(write_certainty IN ('none','intent','acknowledged','refused','unknown')),
  previous_mode text CHECK(previous_mode IN ('none','local','cloud','unknown')),
  verified_at timestamptz, applied_by_us boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,meeting_id,target_hash,retry_generation),
  FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,write_job_id) REFERENCES jobs(workspace_id,id),
  CHECK((first_attempt_at IS NULL)=(deadline_at IS NULL)),
  CHECK(deadline_at IS NULL OR deadline_at<=first_attempt_at+interval '2 hours'),
  CHECK((write_intent_at IS NULL)=(write_owner_token IS NULL) AND (write_intent_at IS NULL)=(write_job_id IS NULL)),
  CHECK(write_certainty NOT IN ('intent','acknowledged','unknown') OR write_intent_at IS NOT NULL),
  CHECK(state<>'ready' OR verified_at IS NOT NULL)
);
CREATE INDEX meeting_recording_setup_due ON meeting_recording_setup(next_attempt_at,id) WHERE state IN ('pending','verifying');
CREATE FUNCTION keep_meeting_recording_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target IS DISTINCT FROM OLD.target OR NEW.target_hash IS DISTINCT FROM OLD.target_hash OR NEW.retry_generation IS DISTINCT FROM OLD.retry_generation THEN
    RAISE EXCEPTION 'recording target is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_recording_target BEFORE UPDATE ON meeting_recording_setup FOR EACH ROW EXECUTE FUNCTION keep_meeting_recording_target();
GRANT SELECT,INSERT,UPDATE,DELETE ON meeting_recording_setup TO app_runtime,migration;
-- Every authoritative identity writer (including merges) invalidates the old revision.
CREATE FUNCTION invalidate_meeting_recording_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meeting_recording_setup SET state='obsolete',reason='target_changed',version=version+1,updated_at=clock_timestamp()
    WHERE workspace_id=NEW.workspace_id AND meeting_id=NEW.id AND state<>'obsolete';
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_recording_identity AFTER UPDATE ON meetings FOR EACH ROW
  WHEN ((OLD.firm_id,OLD.contact_id,OLD.current_booking_uid,OLD.zoom_meeting_id,OLD.attendee_email,OLD.organizer_email,OLD.starts_at,OLD.ends_at,OLD.state)
    IS DISTINCT FROM (NEW.firm_id,NEW.contact_id,NEW.current_booking_uid,NEW.zoom_meeting_id,NEW.attendee_email,NEW.organizer_email,NEW.starts_at,NEW.ends_at,NEW.state))
  EXECUTE FUNCTION invalidate_meeting_recording_target();
-- Restored local state cannot prove which Zoom effects happened after the restore point.
CREATE FUNCTION disable_restored_meeting_recording() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior workspace_settings%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text||':meeting_auto_recording',0));
  SELECT * INTO prior FROM workspace_settings WHERE workspace_id=NEW.workspace_id AND setting_key='meeting_auto_recording' AND superseded_at IS NULL FOR UPDATE;
  IF FOUND AND prior.value->>'enabled'='true' THEN
    UPDATE workspace_settings SET superseded_at=GREATEST(now(),changed_at),superseded_by_version=version+1 WHERE workspace_id=prior.workspace_id AND id=prior.id;
    INSERT INTO workspace_settings(workspace_id,setting_key,version,value,change_note)
      VALUES(prior.workspace_id,'meeting_auto_recording',prior.version+1,jsonb_set(prior.value,'{enabled}','false'),'Disabled for database restore');
  END IF;
  UPDATE meeting_recording_setup SET state='manual',reason='ambiguous_write',version=version+1,updated_at=clock_timestamp()
    WHERE workspace_id=NEW.workspace_id AND state IN ('pending','verifying');
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_recording_restore AFTER INSERT ON active_holds FOR EACH ROW
  WHEN (NEW.reason_code='restore_in_progress' AND NEW.released_at IS NULL)
  EXECUTE FUNCTION disable_restored_meeting_recording();
