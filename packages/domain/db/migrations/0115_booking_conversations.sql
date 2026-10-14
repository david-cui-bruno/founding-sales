-- changes: booking_conversations, crm_mail_sources, crm_mail_source_contexts
-- This aggregate retains IDs, hashes and bounded operational counters only.
-- Interpretation evidence and copied provenance stay in the canonical interpretation.
CREATE TABLE booking_conversations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,
 interpretation_request_id uuid NOT NULL,
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 binding_key text NOT NULL,
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='array' AND octet_length(source_refs::text)<=2048 AND (jsonb_array_length(source_refs) BETWEEN 1 AND 4 OR (state='stale' AND source_refs='[]'::jsonb AND source_fingerprint=repeat('0',64)))),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','awaiting_time','booking_pending','booked','stopped','handoff','stale','unknown')),
 create_submission_id uuid,
 change_submission_id uuid,
 reason text,
 handoff_action text CHECK(handoff_action IN ('answer_sales_question','review_conditional_scheduling','review_booking')),
 nudge_count integer NOT NULL DEFAULT 0 CHECK(nudge_count BETWEEN 0 AND 2),
 nudges_stopped_at timestamptz,
 last_reply_at timestamptz,
 explicit_no_show_at timestamptz,
 no_show_rebooking_used boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,owner_user_id,interpretation_request_id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,interpretation_request_id) REFERENCES crm_booking_interpretations(workspace_id,id),
 FOREIGN KEY(workspace_id,create_submission_id) REFERENCES booking_create_submissions(workspace_id,id),
 FOREIGN KEY(workspace_id,change_submission_id) REFERENCES booking_change_submissions(workspace_id,id)
);
CREATE INDEX booking_conversations_sources ON booking_conversations USING gin(source_refs);
GRANT SELECT,INSERT,UPDATE ON booking_conversations TO app_runtime,migration;
CREATE FUNCTION redact_booking_conversation_provenance(target_workspace uuid,target_source uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE booking_conversations SET state='stale',reason='source_changed',source_refs='[]',source_fingerprint=repeat('0',64),handoff_action=NULL,nudges_stopped_at=COALESCE(nudges_stopped_at,now()),updated_at=now()
 WHERE workspace_id=target_workspace AND source_refs @> jsonb_build_array(jsonb_build_object('sourceId',target_source));
END $$;
CREATE FUNCTION invalidate_booking_conversation_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM redact_booking_conversation_provenance(OLD.workspace_id,OLD.source_id);RETURN OLD;END IF;
 IF NEW IS DISTINCT FROM OLD THEN PERFORM redact_booking_conversation_provenance(OLD.workspace_id,OLD.source_id);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER booking_conversation_source_changed AFTER UPDATE OR DELETE ON crm_mail_sources
 FOR EACH ROW EXECUTE FUNCTION invalidate_booking_conversation_source();
CREATE FUNCTION invalidate_booking_conversation_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM redact_booking_conversation_provenance(OLD.workspace_id,OLD.source_id);RETURN OLD;END IF;
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN PERFORM redact_booking_conversation_provenance(OLD.workspace_id,OLD.source_id);END IF;
 PERFORM redact_booking_conversation_provenance(NEW.workspace_id,NEW.source_id);RETURN NEW;
END $$;
CREATE TRIGGER booking_conversation_context_changed AFTER INSERT OR UPDATE OR DELETE ON crm_mail_source_contexts
 FOR EACH ROW EXECUTE FUNCTION invalidate_booking_conversation_context();
