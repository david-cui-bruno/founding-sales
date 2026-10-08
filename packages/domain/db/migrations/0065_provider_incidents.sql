-- changes: mailbox_provider_incidents
-- Coded, credential/body/address-free incident history. A deadline permits a fresh
-- observation, never dispatch or a resend of an uncertain fence.
CREATE TABLE mailbox_provider_incidents (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 mailbox_id uuid NOT NULL,
 source_kind text NOT NULL,
 source_id text NOT NULL,
 classification text NOT NULL,
 reason text NOT NULL,
 binding_sha256 text,
 observed_at timestamptz NOT NULL,
 retry_at timestamptz,
 hold_id uuid,
 resolved_at timestamptz,
 resolution text,
 CONSTRAINT mailbox_provider_incidents_pkey PRIMARY KEY(workspace_id,id),
 CONSTRAINT mailbox_provider_incidents_mailbox_fkey FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 CONSTRAINT mailbox_provider_incidents_hold_fkey FOREIGN KEY(workspace_id,hold_id) REFERENCES active_holds(workspace_id,id),
 CONSTRAINT mailbox_provider_incidents_source_known CHECK(source_kind IN ('sent_search','token_refresh','mail_read','provider_send','admin_report')),
 CONSTRAINT mailbox_provider_incidents_source_present CHECK(source_id ~ '^[a-zA-Z0-9:_-]{1,160}$'),
 CONSTRAINT mailbox_provider_incidents_class_known CHECK(classification IN ('transient','authentication','reputation','unknown')),
 CONSTRAINT mailbox_provider_incidents_reason_coded CHECK(reason ~ '^[a-z][a-z0-9_]{0,79}$'),
 CONSTRAINT mailbox_provider_incidents_binding_shape CHECK(binding_sha256 ~ '^[a-f0-9]{64}$'),
 CONSTRAINT mailbox_provider_incidents_retry_order CHECK(retry_at IS NULL OR retry_at>=observed_at),
 CONSTRAINT mailbox_provider_incidents_resolution_consistent CHECK((resolved_at IS NULL)=(resolution IS NULL) AND (resolution IS NULL OR resolution IN ('verified_read','human_revalidated'))),
 CONSTRAINT mailbox_provider_incidents_resolution_order CHECK(resolved_at IS NULL OR resolved_at>=observed_at)
);
CREATE UNIQUE INDEX mailbox_provider_incidents_one_open_source ON mailbox_provider_incidents(workspace_id,mailbox_id,source_kind,source_id) WHERE resolved_at IS NULL;
GRANT SELECT,INSERT,UPDATE ON mailbox_provider_incidents TO app_runtime,migration;
