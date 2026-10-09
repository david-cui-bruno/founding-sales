-- Provisional order assigned finally by root; no activation.
CREATE TABLE crm_mail_progress_receipts (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL, source_revision integer NOT NULL CHECK(source_revision>0),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 owner_user_id uuid, mailbox_id uuid,
 account_binding text CHECK(account_binding ~ '^[a-f0-9]{64}$'),
 event_kind text NOT NULL CHECK(event_kind IN ('contacted','replied')),
 provider_at timestamptz,
 context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),
 original_firm_ids uuid[] NOT NULL CHECK(cardinality(original_firm_ids)<=100),
 original_person_ids uuid[] NOT NULL CHECK(cardinality(original_person_ids)<=100),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleted')),
 CHECK(state<>'active' OR (owner_user_id IS NOT NULL AND mailbox_id IS NOT NULL AND account_binding IS NOT NULL AND provider_at IS NOT NULL)),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,source_id,source_revision,source_hash,event_kind,context_hash),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id)
);
CREATE TABLE crm_mail_reply_resolutions (
 workspace_id uuid NOT NULL, request_message_id uuid NOT NULL,
 sent_receipt_id uuid NOT NULL, request_provider_at timestamptz,
 PRIMARY KEY(workspace_id,request_message_id),
 FOREIGN KEY(workspace_id,sent_receipt_id) REFERENCES crm_mail_progress_receipts(workspace_id,id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_mail_progress_receipts,crm_mail_reply_resolutions TO app_runtime,migration;
