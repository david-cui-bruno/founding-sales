-- changes: outreach_settings, follow_up_permissions
ALTER TABLE outreach_settings ADD COLUMN reply_sequence_version_id uuid,
 ADD COLUMN booking_url text CHECK(booking_url IS NULL OR (length(booking_url)<=2000 AND booking_url LIKE 'https://cal.com/%')),
 ADD CONSTRAINT outreach_reply_sequence FOREIGN KEY(workspace_id,reply_sequence_version_id) REFERENCES sequence_versions(workspace_id,id);
ALTER TABLE follow_up_permissions DROP CONSTRAINT follow_up_permissions_scope_known,
 ADD CONSTRAINT follow_up_permissions_scope_known CHECK(scope IN ('single_email','contextual_reply','booking_communications','agreed_sequence','routine_reply')),
 DROP CONSTRAINT follow_up_permissions_template_iff_single_email,
 ADD CONSTRAINT follow_up_permissions_template_iff_single_email CHECK((scope IN ('single_email','routine_reply'))=(template_version_id IS NOT NULL)),
 DROP CONSTRAINT follow_up_permissions_consumption_is_one_message,
 ADD CONSTRAINT follow_up_permissions_consumption_is_one_message CHECK(consumed_at IS NULL OR scope IN ('single_email','contextual_reply','routine_reply'));
CREATE TABLE outreach_reply_deliveries (
 workspace_id uuid NOT NULL,
 request_id uuid NOT NULL,
 permission_id uuid NOT NULL,
 sequence_version_id uuid NOT NULL,
 template_version_id uuid NOT NULL,
 template_hash text NOT NULL CHECK(template_hash ~ '^[0-9a-f]{64}$'),
 draft_hash text NOT NULL CHECK(draft_hash ~ '^[0-9a-f]{64}$'),
 thread_id text NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 1024),
 reply_to text NOT NULL CHECK(length(reply_to) BETWEEN 1 AND 998),
 reference_ids text[] NOT NULL,
 execution_id uuid,
 fence_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,request_id),
 UNIQUE(workspace_id,permission_id),
 UNIQUE(workspace_id,execution_id),
 UNIQUE(workspace_id,fence_id),
 FOREIGN KEY(workspace_id,request_id) REFERENCES outreach_reply_requests(workspace_id,id),
 FOREIGN KEY(workspace_id,permission_id) REFERENCES follow_up_permissions(workspace_id,id),
 FOREIGN KEY(workspace_id,sequence_version_id) REFERENCES sequence_versions(workspace_id,id),
 FOREIGN KEY(workspace_id,template_version_id) REFERENCES template_versions(workspace_id,id),
 FOREIGN KEY(workspace_id,execution_id) REFERENCES step_executions(workspace_id,id),
 FOREIGN KEY(workspace_id,fence_id) REFERENCES outbound_messages(workspace_id,id)
);
GRANT SELECT,INSERT,DELETE ON outreach_reply_deliveries TO app_runtime;
GRANT UPDATE(execution_id,fence_id) ON outreach_reply_deliveries TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON outreach_reply_deliveries TO migration;
