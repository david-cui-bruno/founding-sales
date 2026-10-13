-- #621: body-free durable create identity. Unknown dispatches never return to pending.
CREATE TABLE booking_create_submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 owner_user_id uuid NOT NULL REFERENCES users(id),
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 binding_key text NOT NULL CHECK(length(binding_key) BETWEEN 1 AND 256),
 provider_account_id bigint NOT NULL CHECK(provider_account_id>0),
 event_type_id bigint NOT NULL CHECK(event_type_id>0),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 provenance_state text NOT NULL DEFAULT 'current' CHECK(provenance_state IN ('current','redacted')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 starts_at timestamptz NOT NULL,
 buffer_ends_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','failed','unknown')),
 dispatch_started_at timestamptz,
 provider_booking_uid text CHECK(provider_booking_uid ~ '^[A-Za-z0-9_-]{1,128}$'),
 meeting_id uuid,
 reason text CHECK(reason ~ '^[a-z][a-z0-9_]{1,79}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT booking_create_identity UNIQUE(workspace_id,owner_user_id,request_hash),
 CONSTRAINT booking_create_workspace_id UNIQUE(workspace_id,id),
 CONSTRAINT booking_create_meeting FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id) ON DELETE SET NULL (meeting_id),
 CONSTRAINT booking_create_provenance_shape CHECK((provenance_state='current' AND source_fingerprint<>repeat('0',64) AND payload ? 'agreement' AND payload ? 'attendeeRouteId') OR (provenance_state='redacted' AND source_fingerprint=repeat('0',64) AND payload='{}'::jsonb)),
 CONSTRAINT booking_create_window CHECK(buffer_ends_at=starts_at+interval '30 minutes'),
 CONSTRAINT booking_create_accepted_evidence CHECK(state<>'accepted' OR (dispatch_started_at IS NOT NULL AND provider_booking_uid IS NOT NULL)),
 CONSTRAINT booking_create_unknown_dispatch CHECK(state<>'unknown' OR dispatch_started_at IS NOT NULL)
);
CREATE INDEX booking_create_slot_gate ON booking_create_submissions(workspace_id,provider_account_id,starts_at) WHERE state IN ('pending','accepted','unknown');
GRANT SELECT,INSERT,UPDATE ON booking_create_submissions TO app_runtime;

-- Source -> receipt, matching ordinary canonical source deletion/correction locks.
-- These retained hashes/identities are receipt dedupe barriers, never source access.
CREATE FUNCTION redact_booking_create_provenance(target_workspace uuid,target_source uuid,redaction_reason text) RETURNS void LANGUAGE sql AS $$
 UPDATE booking_create_submissions SET payload='{}',provenance_state='redacted',source_fingerprint=repeat('0',64),
 state=CASE WHEN dispatch_started_at IS NULL THEN 'failed' ELSE state END,
 reason=redaction_reason,updated_at=now()
 WHERE workspace_id=target_workspace AND provenance_state='current'
 AND (payload#>>'{agreement,sourceId}'=target_source::text OR payload#>>'{offeredContext,sourceId}'=target_source::text);
$$;
REVOKE ALL ON FUNCTION redact_booking_create_provenance(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redact_booking_create_provenance(uuid,uuid,text) TO app_runtime;
CREATE FUNCTION booking_create_source_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM redact_booking_create_provenance(OLD.workspace_id,OLD.source_id,'source_deleted');
  RETURN OLD;
 END IF;
 IF NEW.availability IS DISTINCT FROM OLD.availability AND NEW.availability<>'available'
 OR NEW.source_revision IS DISTINCT FROM OLD.source_revision OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
 OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.account_binding IS DISTINCT FROM OLD.account_binding
 OR NEW.acquired_generation IS DISTINCT FROM OLD.acquired_generation
 OR NEW.original_availability IS DISTINCT FROM OLD.original_availability AND NEW.original_availability NOT IN ('unknown','available') THEN
  PERFORM redact_booking_create_provenance(OLD.workspace_id,OLD.source_id,CASE WHEN NEW.availability='deleted' THEN 'source_deleted' ELSE 'source_authority_changed' END);
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER booking_create_source_privacy AFTER DELETE OR UPDATE OF availability,source_revision,content_hash,owner_user_id,account_binding,acquired_generation,original_availability ON crm_mail_sources FOR EACH ROW EXECUTE FUNCTION booking_create_source_privacy();
CREATE FUNCTION booking_create_context_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM redact_booking_create_provenance(OLD.workspace_id,OLD.source_id,'source_authority_changed');RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  PERFORM redact_booking_create_provenance(OLD.workspace_id,OLD.source_id,'source_authority_changed');
 END IF;
 PERFORM redact_booking_create_provenance(NEW.workspace_id,NEW.source_id,'source_authority_changed');RETURN NEW;
END;
$$;
CREATE TRIGGER booking_create_context_privacy AFTER INSERT OR UPDATE OR DELETE ON crm_mail_source_contexts FOR EACH ROW EXECUTE FUNCTION booking_create_context_privacy();
