-- changes: booking_message_requests, outbound_messages
-- #624 body-free standing booking message identity. Existing outbound fence is the only send surface.
ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_origin_kind_known;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_origin_kind_known CHECK(origin_kind IN('step_execution','draft','standing_booking'));
CREATE TABLE booking_message_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id),
 conversation_id uuid NOT NULL,owner_user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN('approved_link','clarification','nudge_3','nudge_7','no_show')),policy_revision integer NOT NULL CHECK(policy_revision>0),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 outbound_message_id uuid,consumed_at timestamptz,reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),CONSTRAINT booking_message_source_kind UNIQUE(workspace_id,conversation_id,source_fingerprint,kind),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES booking_conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,outbound_message_id) REFERENCES outbound_messages(workspace_id,id),
 CHECK(consumed_at IS NULL OR outbound_message_id IS NOT NULL)
);
GRANT SELECT,INSERT,UPDATE ON booking_message_requests TO app_runtime;
CREATE FUNCTION booking_message_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.workspace_id,NEW.conversation_id,NEW.owner_user_id,NEW.kind,NEW.policy_revision,NEW.source_fingerprint,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.conversation_id,OLD.owner_user_id,OLD.kind,OLD.policy_revision,OLD.source_fingerprint,OLD.created_at)
 OR (OLD.outbound_message_id IS NOT NULL AND NEW.outbound_message_id IS DISTINCT FROM OLD.outbound_message_id)
 OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
  RAISE EXCEPTION 'booking message identity and consumption are irreversible' USING ERRCODE='23514',CONSTRAINT='booking_message_identity_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER booking_message_identity_guard BEFORE UPDATE ON booking_message_requests FOR EACH ROW EXECUTE FUNCTION booking_message_identity_guard();

-- Only an unattempted dependent draft contains erasable copied source subject.
-- Attempted/unknown/sent envelopes remain immutable provider-attempt evidence.
-- Replace the earlier function after the durable message/fence link exists.
CREATE OR REPLACE FUNCTION redact_booking_conversation_provenance(target_workspace uuid,target_source uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE outbound_messages o SET subject='Re: Our call',updated_at=now()
 FROM booking_message_requests r JOIN booking_conversations c
 ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
 WHERE o.workspace_id=target_workspace AND r.workspace_id=o.workspace_id
 AND r.outbound_message_id=o.id AND o.origin_kind='standing_booking'
 AND o.attempt_token IS NULL AND o.dispatch_started_at IS NULL
 AND c.source_refs @> jsonb_build_array(jsonb_build_object('sourceId',target_source));
 UPDATE booking_conversations SET state='stale',reason='source_changed',source_refs='[]',source_fingerprint=repeat('0',64),source_conversation_id=NULL,handoff_action=NULL,target_meeting_id=NULL,target_booking_uid=NULL,nudges_stopped_at=COALESCE(nudges_stopped_at,now()),updated_at=now()
 WHERE workspace_id=target_workspace AND source_refs @> jsonb_build_array(jsonb_build_object('sourceId',target_source));
END $$;
