-- changes: call_sessions, dial_tickets, browser_audio_test_requests
-- Explicit personal audio tests share the existing session/money/provider lifecycle.
-- Legacy phone handoffs retain their independent strict posture/window rules.
CREATE TABLE browser_audio_test_requests (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 actor_user_id uuid NOT NULL,device_id uuid NOT NULL,calling_identity_id uuid NOT NULL,
 command_id text NOT NULL,e164 text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 erased_at timestamptz,
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,device_id,command_id),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,device_id) REFERENCES devices(workspace_id,id),
 FOREIGN KEY(workspace_id,calling_identity_id) REFERENCES calling_identities(workspace_id,id),
 CHECK(command_id~'^[0-9a-zA-Z_:-]{1,128}$'),
 CHECK(isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at
  AND expires_at<=created_at+INTERVAL '60 seconds'),
 CHECK(((erased_at IS NULL AND e164~'^\+1[2-9][0-9]{2}[2-9][0-9]{6}$')
  OR(erased_at IS NOT NULL AND isfinite(erased_at) AND erased_at>=created_at AND e164 IS NULL)) IS TRUE)
);
CREATE INDEX browser_audio_test_requests_expiry ON browser_audio_test_requests(workspace_id,expires_at) WHERE erased_at IS NULL;
CREATE FUNCTION browser_audio_test_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Audio test request history is retained' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['e164','erased_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['e164','erased_at'])
  OR (ROW(NEW.e164,NEW.erased_at) IS DISTINCT FROM ROW(OLD.e164,OLD.erased_at)
   AND NOT(OLD.erased_at IS NULL AND NEW.e164 IS NULL AND NEW.erased_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'Audio test identity and original lifetime are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER browser_audio_test_request_guard BEFORE UPDATE OR DELETE ON browser_audio_test_requests
 FOR EACH ROW EXECUTE FUNCTION browser_audio_test_request_guard();

ALTER TABLE call_sessions ADD COLUMN purpose text NOT NULL DEFAULT 'business',ADD COLUMN audio_test_request_id uuid,
 ALTER COLUMN firm_id DROP NOT NULL,ALTER COLUMN ticket_id DROP NOT NULL;
ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_audio_test_request_fkey
 FOREIGN KEY(workspace_id,audio_test_request_id) REFERENCES browser_audio_test_requests(workspace_id,id),
 ADD CONSTRAINT call_sessions_one_per_audio_test UNIQUE(workspace_id,audio_test_request_id),
 ADD CONSTRAINT call_sessions_purpose_shape CHECK(
  (purpose='business' AND audio_test_request_id IS NULL AND firm_id IS NOT NULL AND ticket_id IS NOT NULL)
  OR(purpose='audio_test' AND audio_test_request_id IS NOT NULL AND firm_id IS NULL AND ticket_id IS NULL
   AND contact_id IS NULL AND call_log_id IS NULL));
CREATE FUNCTION call_session_purpose_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request browser_audio_test_requests;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.purpose='audio_test' THEN RAISE EXCEPTION 'Audio test session history is retained' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.purpose,NEW.audio_test_request_id) IS DISTINCT FROM ROW(OLD.purpose,OLD.audio_test_request_id) THEN
  RAISE EXCEPTION 'Call purpose cannot change' USING ERRCODE='23514';
 END IF;
 IF NEW.purpose='audio_test' THEN
  SELECT * INTO request FROM browser_audio_test_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.audio_test_request_id;
  IF NOT FOUND OR NEW.actor_user_id<>request.actor_user_id OR NEW.expires_at>request.expires_at THEN
   RAISE EXCEPTION 'Audio test session must retain its exact request and actor' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.workspace_id,NEW.id,NEW.actor_user_id,NEW.reservation_id,NEW.expires_at)
   IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.actor_user_id,OLD.reservation_id,OLD.expires_at) THEN
   RAISE EXCEPTION 'Audio test session identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.consumed_at IS NOT NULL AND ROW(NEW.consumed_at,NEW.twilio_call_sid)
   IS DISTINCT FROM ROW(OLD.consumed_at,OLD.twilio_call_sid) THEN
   RAISE EXCEPTION 'Audio test consumption cannot reset' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND ((OLD.status<>'authorized' AND NEW.status='authorized')
   OR(OLD.status='in_progress' AND NEW.status='ringing')
   OR(OLD.status IN('completed','failed','canceled') AND NEW.status<>OLD.status)
   OR(OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at)) THEN
   RAISE EXCEPTION 'Audio test progress cannot reset' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER call_session_purpose_guard BEFORE INSERT OR UPDATE OR DELETE ON call_sessions
 FOR EACH ROW EXECUTE FUNCTION call_session_purpose_guard();

-- Dial tickets now have only browser execution owners. Nullable evidence means
-- unknown or no longer required; it must never be filled with a fictional posture/zone.
ALTER TABLE dial_tickets ALTER COLUMN posture_id DROP NOT NULL,ALTER COLUMN posture_revision DROP NOT NULL;
ALTER TABLE dial_tickets ADD CONSTRAINT dial_tickets_posture_pair
 CHECK((posture_id IS NULL)=(posture_revision IS NULL));
ALTER TABLE dial_tickets DROP CONSTRAINT dial_tickets_preparation_erasure;
ALTER TABLE dial_tickets ADD CONSTRAINT dial_tickets_preparation_erasure CHECK(
 (calling_preparation_erased_at IS NULL AND e164 IS NOT NULL)
 OR(calling_preparation_id IS NOT NULL AND calling_preparation_erased_at IS NOT NULL
  AND isfinite(calling_preparation_erased_at) AND calling_preparation_erased_at>=issued_at AND e164 IS NULL AND firm_time_zone IS NULL));

REVOKE ALL ON browser_audio_test_requests FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON browser_audio_test_requests TO app_runtime,migration;
REVOKE ALL ON FUNCTION browser_audio_test_request_guard(),call_session_purpose_guard() FROM PUBLIC;
