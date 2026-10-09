-- Provisional order assigned finally by root; no activation.
CREATE FUNCTION crm_progress_context_ids_valid(ids uuid[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT cardinality(ids)<=100 AND array_position(ids,NULL) IS NULL
 AND (cardinality(ids)=0 OR (array_ndims(ids)=1 AND array_lower(ids,1)=1))
 AND ids=COALESCE((SELECT array_agg(DISTINCT value ORDER BY value) FROM unnest(ids) value),'{}'::uuid[])
$$;
CREATE TABLE crm_mail_progress_receipts (
 workspace_id uuid NOT NULL CONSTRAINT crm_progress_workspace_fk REFERENCES workspaces(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL, source_revision integer NOT NULL CONSTRAINT crm_progress_source_revision CHECK(source_revision>0),
 source_hash text NOT NULL CONSTRAINT crm_progress_source_hash CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 owner_user_id uuid, mailbox_id uuid,
 account_binding text CONSTRAINT crm_progress_account_binding CHECK(account_binding ~ '^[a-f0-9]{64}$'),
 event_kind text NOT NULL CONSTRAINT crm_progress_event_kind CHECK(event_kind IN ('contacted','replied')),
 provider_at timestamptz,
 prerequisite_source_id uuid, prerequisite_source_revision integer CONSTRAINT crm_progress_prerequisite_revision CHECK(prerequisite_source_revision>0),
 prerequisite_source_hash text CONSTRAINT crm_progress_prerequisite_hash CHECK(prerequisite_source_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT crm_progress_prerequisite_tuple CHECK((prerequisite_source_id IS NULL)=(prerequisite_source_revision IS NULL) AND (prerequisite_source_id IS NULL)=(prerequisite_source_hash IS NULL)),
 CONSTRAINT crm_progress_reply_prerequisite CHECK(state<>'active' OR event_kind<>'replied' OR prerequisite_source_id IS NOT NULL),
 context_hash text NOT NULL CONSTRAINT crm_progress_context_hash CHECK(context_hash ~ '^[a-f0-9]{64}$'),
 original_firm_ids uuid[] NOT NULL CONSTRAINT crm_progress_firm_ids CHECK(crm_progress_context_ids_valid(original_firm_ids)),
 original_person_ids uuid[] NOT NULL CONSTRAINT crm_progress_person_ids CHECK(crm_progress_context_ids_valid(original_person_ids)),
 state text NOT NULL DEFAULT 'active' CONSTRAINT crm_progress_state CHECK(state IN ('active','deleted')),
 CONSTRAINT crm_progress_active_proof CHECK(state<>'active' OR (owner_user_id IS NOT NULL AND mailbox_id IS NOT NULL AND account_binding IS NOT NULL AND provider_at IS NOT NULL)),
 CONSTRAINT crm_progress_receipts_pkey PRIMARY KEY(workspace_id,id),
 CONSTRAINT crm_progress_receipts_exact UNIQUE(workspace_id,source_id,source_revision,source_hash,event_kind,context_hash),
 CONSTRAINT crm_progress_owner_fk FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT crm_progress_mailbox_fk FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id)
);
CREATE TABLE crm_mail_reply_resolutions (
 workspace_id uuid NOT NULL CONSTRAINT crm_reply_resolutions_workspace_fk REFERENCES workspaces(id), request_message_id uuid NOT NULL,
 sent_receipt_id uuid, request_provider_at timestamptz,
 CONSTRAINT crm_reply_resolutions_pkey PRIMARY KEY(workspace_id,request_message_id),
 CONSTRAINT crm_reply_resolutions_receipt_fk FOREIGN KEY(workspace_id,sent_receipt_id) REFERENCES crm_mail_progress_receipts(workspace_id,id) ON DELETE SET NULL (sent_receipt_id)
);
-- A completion's identity is permanent; sensitive attribution can only be scrubbed.
CREATE FUNCTION crm_completion_redaction_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.request_message_id IS DISTINCT FROM OLD.request_message_id
 OR (NEW.sent_receipt_id IS DISTINCT FROM OLD.sent_receipt_id AND NEW.sent_receipt_id IS NOT NULL)
 OR (NEW.request_provider_at IS DISTINCT FROM OLD.request_provider_at AND NEW.request_provider_at IS NOT NULL) THEN
  RAISE EXCEPTION 'CRM completion permits only attribution redaction' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_completion_redaction_only BEFORE UPDATE ON crm_mail_reply_resolutions
 FOR EACH ROW EXECUTE FUNCTION crm_completion_redaction_only();
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_mail_progress_receipts TO app_runtime,migration;
GRANT SELECT,INSERT ON crm_mail_reply_resolutions TO app_runtime,migration;
GRANT UPDATE(sent_receipt_id,request_provider_at) ON crm_mail_reply_resolutions TO app_runtime,migration;
-- Cursor advances scan coverage only; it does not certify projection or permission.
CREATE TABLE crm_mail_progress_scan_cursors (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), last_source_id uuid
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_mail_progress_scan_cursors TO app_runtime,migration;
