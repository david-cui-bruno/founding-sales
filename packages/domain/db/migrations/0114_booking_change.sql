-- changes: booking_change_submissions, crm_mail_sources, crm_mail_source_contexts, workspace_settings, suppression_events
-- #623 isolated durable change receipt. No content, new funding or reminder platform.
CREATE TABLE booking_change_submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 owner_user_id uuid NOT NULL REFERENCES users(id),
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 binding_key text NOT NULL CHECK(length(binding_key) BETWEEN 1 AND 256),
 provider_account_id bigint NOT NULL CHECK(provider_account_id>0),
 event_type_id bigint NOT NULL CHECK(event_type_id>0),
 action text NOT NULL CHECK(action IN ('reschedule','cancel')),
 target_booking_uid text NOT NULL CHECK(target_booking_uid ~ '^[A-Za-z0-9_-]{1,128}$'),
 target_fingerprint text NOT NULL CHECK(target_fingerprint ~ '^[a-f0-9]{64}$'),
 original_starts_at timestamptz NOT NULL,
 original_ends_at timestamptz NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 provenance_state text NOT NULL DEFAULT 'current' CHECK(provenance_state IN ('current','redacted')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 starts_at timestamptz,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','failed','unknown')),
 dispatch_started_at timestamptz,
 provider_booking_uid text CHECK(provider_booking_uid ~ '^[A-Za-z0-9_-]{1,128}$'),
 meeting_id uuid,
 reminder_state text NOT NULL DEFAULT 'unverified' CHECK(reminder_state IN ('unverified','replaced','stopped')),
 reason text CHECK(reason ~ '^[a-z][a-z0-9_]{1,79}$'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT booking_change_identity UNIQUE(workspace_id,owner_user_id,request_hash),
 CONSTRAINT booking_change_workspace_id UNIQUE(workspace_id,id),
 CONSTRAINT booking_change_meeting FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id) ON DELETE SET NULL (meeting_id),
 CONSTRAINT booking_change_provenance_shape CHECK((provenance_state='current' AND source_fingerprint<>repeat('0',64) AND payload ? 'agreement' AND payload ? 'attendeeRouteId') OR (provenance_state='redacted' AND source_fingerprint=repeat('0',64) AND target_fingerprint=repeat('0',64) AND payload='{}'::jsonb)),
 CONSTRAINT booking_change_window CHECK(original_ends_at=original_starts_at+interval '20 minutes' AND ((action='cancel' AND starts_at IS NULL) OR (action='reschedule' AND starts_at IS NOT NULL))),
 CONSTRAINT booking_change_accepted_evidence CHECK(state<>'accepted' OR (dispatch_started_at IS NOT NULL AND provider_booking_uid IS NOT NULL AND ((action='cancel' AND reminder_state='stopped') OR (action='reschedule' AND reminder_state='replaced')))),
 CONSTRAINT booking_change_unknown_dispatch CHECK(state<>'unknown' OR dispatch_started_at IS NOT NULL)
);
CREATE UNIQUE INDEX booking_change_active_target ON booking_change_submissions(workspace_id,provider_account_id,target_booking_uid) WHERE state IN ('pending','unknown');
CREATE INDEX booking_change_slot_gate ON booking_change_submissions(workspace_id,provider_account_id,starts_at) WHERE action='reschedule' AND state IN ('pending','unknown');
GRANT SELECT,INSERT,UPDATE ON booking_change_submissions TO app_runtime;
CREATE FUNCTION booking_change_marker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at
 OR OLD.state IN ('accepted','failed') AND NEW.state IS DISTINCT FROM OLD.state
 OR OLD.provenance_state='redacted' AND NEW.provenance_state<>'redacted' THEN
  RAISE EXCEPTION 'booking change receipt is irreversible' USING ERRCODE='23514',CONSTRAINT='booking_change_marker_irreversible';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER booking_change_marker_guard BEFORE UPDATE ON booking_change_submissions FOR EACH ROW EXECUTE FUNCTION booking_change_marker_guard();
CREATE FUNCTION redact_booking_change_provenance(target_workspace uuid,target_source uuid,redaction_reason text) RETURNS void LANGUAGE sql AS $$
 UPDATE booking_change_submissions SET payload='{}',provenance_state='redacted',source_fingerprint=repeat('0',64),target_fingerprint=repeat('0',64),
 state=CASE WHEN dispatch_started_at IS NULL AND state='pending' THEN 'failed' ELSE state END,reason=redaction_reason,updated_at=now()
 WHERE workspace_id=target_workspace AND provenance_state='current'
 AND (payload#>>'{agreement,sourceId}'=target_source::text OR payload#>>'{offeredContext,sourceId}'=target_source::text);
$$;
REVOKE ALL ON FUNCTION redact_booking_change_provenance(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redact_booking_change_provenance(uuid,uuid,text) TO app_runtime;
CREATE FUNCTION booking_change_source_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM redact_booking_change_provenance(OLD.workspace_id,OLD.source_id,'source_deleted');RETURN OLD;END IF;
 IF NEW.availability IS DISTINCT FROM OLD.availability AND NEW.availability<>'available'
 OR NEW.source_revision IS DISTINCT FROM OLD.source_revision OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
 OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.account_binding IS DISTINCT FROM OLD.account_binding
 OR NEW.acquired_generation IS DISTINCT FROM OLD.acquired_generation
 OR NEW.original_availability IS DISTINCT FROM OLD.original_availability AND NEW.original_availability NOT IN ('unknown','available') THEN
  PERFORM redact_booking_change_provenance(OLD.workspace_id,OLD.source_id,CASE WHEN NEW.availability='deleted' THEN 'source_deleted' ELSE 'source_authority_changed' END);
 END IF;RETURN NEW;
END;
$$;
CREATE TRIGGER booking_change_source_privacy AFTER DELETE OR UPDATE OF availability,source_revision,content_hash,owner_user_id,account_binding,acquired_generation,original_availability ON crm_mail_sources FOR EACH ROW EXECUTE FUNCTION booking_change_source_privacy();
CREATE FUNCTION booking_change_context_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM redact_booking_change_provenance(OLD.workspace_id,OLD.source_id,'source_authority_changed');RETURN OLD;END IF;
 IF TG_OP='UPDATE' THEN IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW;END IF;PERFORM redact_booking_change_provenance(OLD.workspace_id,OLD.source_id,'source_authority_changed');END IF;
 PERFORM redact_booking_change_provenance(NEW.workspace_id,NEW.source_id,'source_authority_changed');RETURN NEW;
END;
$$;
CREATE TRIGGER booking_change_context_privacy AFTER INSERT OR UPDATE OR DELETE ON crm_mail_source_contexts FOR EACH ROW EXECUTE FUNCTION booking_change_context_privacy();
-- Relevant new policy revision and explicit opt-out erase only private request provenance.
CREATE FUNCTION booking_change_policy_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.setting_key='booking_policy' THEN
  UPDATE booking_change_submissions SET payload='{}',provenance_state='redacted',source_fingerprint=repeat('0',64),target_fingerprint=repeat('0',64),
   state=CASE WHEN dispatch_started_at IS NULL AND state='pending' THEN 'failed' ELSE state END,reason='policy_changed',updated_at=now()
   WHERE workspace_id=NEW.workspace_id AND provenance_state='current' AND policy_revision<>NEW.version;
 END IF;RETURN NEW;
END;
$$;
CREATE TRIGGER booking_change_policy_privacy AFTER INSERT ON workspace_settings FOR EACH ROW EXECUTE FUNCTION booking_change_policy_privacy();
CREATE FUNCTION booking_change_optout_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source IN ('prospect_opt_out','prospect_do_not_call','salesperson_manual','import') THEN
  UPDATE booking_change_submissions b SET payload='{}',provenance_state='redacted',source_fingerprint=repeat('0',64),target_fingerprint=repeat('0',64),
   state=CASE WHEN dispatch_started_at IS NULL AND state='pending' THEN 'failed' ELSE state END,reason='attendee_opted_out',updated_at=now()
   WHERE b.workspace_id=NEW.workspace_id AND b.provenance_state='current' AND EXISTS(
    SELECT 1 FROM email_addresses e WHERE e.workspace_id=b.workspace_id AND e.id::text=b.payload->>'attendeeRouteId'
    AND ((NEW.scope='firm' AND NEW.canonical_key=e.firm_id::text) OR (NEW.scope='handle' AND NEW.canonical_key=lower(e.address))));
 END IF;RETURN NEW;
END;
$$;
CREATE TRIGGER booking_change_optout_privacy AFTER INSERT ON suppression_events FOR EACH ROW EXECUTE FUNCTION booking_change_optout_privacy();
