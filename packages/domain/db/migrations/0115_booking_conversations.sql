-- changes: booking_conversations, crm_mail_sources, crm_mail_source_contexts, meetings
-- This aggregate retains IDs, hashes and bounded operational counters only.
-- Interpretation evidence and copied provenance stay in the canonical interpretation.
CREATE TABLE booking_conversations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,
 interpretation_request_id uuid NOT NULL,
 source_conversation_id uuid,
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 binding_key text NOT NULL,
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 source_refs jsonb NOT NULL CONSTRAINT booking_conversations_source_refs_check CHECK(jsonb_typeof(source_refs)='array' AND octet_length(source_refs::text)<=2048 AND (jsonb_array_length(source_refs) BETWEEN 1 AND 4 OR (state='stale' AND source_refs='[]'::jsonb AND source_fingerprint=repeat('0',64)))),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','awaiting_time','booking_pending','booked','stopped','handoff','stale','unknown')),
 create_submission_id uuid,
 change_submission_id uuid,
 target_meeting_id uuid,
 target_booking_uid text CHECK(target_booking_uid ~ '^[A-Za-z0-9_-]{1,128}$'),
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
 CONSTRAINT booking_conversation_owner_interpretation UNIQUE(workspace_id,owner_user_id,interpretation_request_id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT booking_conversation_interpretation FOREIGN KEY(workspace_id,interpretation_request_id) REFERENCES crm_booking_interpretations(workspace_id,id),
 FOREIGN KEY(workspace_id,source_conversation_id) REFERENCES crm_business_conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,create_submission_id) REFERENCES booking_create_submissions(workspace_id,id),
 FOREIGN KEY(workspace_id,change_submission_id) REFERENCES booking_change_submissions(workspace_id,id)
 ,FOREIGN KEY(workspace_id,target_meeting_id) REFERENCES meetings(workspace_id,id)
 ,CONSTRAINT booking_conversation_target_pair CHECK((target_meeting_id IS NULL)=(target_booking_uid IS NULL))
);
CREATE INDEX booking_conversations_sources ON booking_conversations USING gin(source_refs);
CREATE UNIQUE INDEX booking_conversation_owner_source_episode ON booking_conversations
 (workspace_id,owner_user_id,(source_refs->0->>'sourceId')) WHERE jsonb_array_length(source_refs)>0;
GRANT SELECT,INSERT,UPDATE ON booking_conversations TO app_runtime,migration;
CREATE FUNCTION redact_booking_conversation_provenance(target_workspace uuid,target_source uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE booking_conversations SET state='stale',reason='source_changed',source_refs='[]',source_fingerprint=repeat('0',64),source_conversation_id=NULL,handoff_action=NULL,target_meeting_id=NULL,target_booking_uid=NULL,nudges_stopped_at=COALESCE(nudges_stopped_at,now()),updated_at=now()
 WHERE workspace_id=target_workspace AND source_refs @> jsonb_build_array(jsonb_build_object('sourceId',target_source));
END $$;
-- Subject deletion removes a meeting, not its irreversible orchestration receipts.
-- Detach the paired live identifiers together before the retained FK is checked.
CREATE FUNCTION detach_booking_conversation_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE booking_conversations SET target_meeting_id=NULL,target_booking_uid=NULL,updated_at=now()
 WHERE workspace_id=OLD.workspace_id AND target_meeting_id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER booking_conversation_target_deleted BEFORE DELETE ON meetings
 FOR EACH ROW EXECUTE FUNCTION detach_booking_conversation_target();
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

-- Only canonical publication in the same owner/account/thread can interrupt work.
-- Historical backfill is not a new reply. Unknown ordering holds rather than resumes.
CREATE FUNCTION stop_booking_conversation_on_reply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.availability<>'available' OR NEW.diagnostic_authorization_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM mail_messages WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id AND direction='incoming') THEN RETURN NEW;END IF;
 UPDATE booking_conversations b SET nudges_stopped_at=COALESCE(b.nudges_stopped_at,now()),
 last_reply_at=COALESCE(NEW.provider_at,now()),
 state=CASE WHEN b.state IN ('pending','booking_pending','awaiting_time') THEN 'handoff' ELSE b.state END,
 reason=CASE WHEN NEW.provider_at>original.provider_at THEN 'new_reply_requires_interpretation' ELSE 'reply_order_unknown' END,
 handoff_action=COALESCE(b.handoff_action,'review_booking'),updated_at=now()
 FROM crm_mail_sources original
 WHERE b.workspace_id=NEW.workspace_id AND b.owner_user_id=NEW.owner_user_id
 AND b.source_conversation_id=NEW.conversation_id
 AND original.workspace_id=b.workspace_id AND original.source_id=(b.source_refs->0->>'sourceId')::uuid
 AND original.account_binding=NEW.account_binding AND original.acquired_generation=NEW.acquired_generation
 AND original.source_id<>NEW.source_id
 AND (NEW.provider_at>=original.provider_at OR NEW.provider_at IS NULL OR original.provider_at IS NULL)
 AND b.state NOT IN ('stale','stopped');
 RETURN NEW;
END $$;
CREATE TRIGGER booking_conversation_reply_stop AFTER INSERT ON crm_mail_sources
 FOR EACH ROW EXECUTE FUNCTION stop_booking_conversation_on_reply();
