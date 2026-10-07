CREATE TABLE outreach_email_admission_settings (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
 revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT false,
 owner_user_id uuid,
 mailbox_id uuid,
 sequence_version_id uuid,
 evaluation jsonb CHECK(evaluation IS NULL OR octet_length(evaluation::text)<=4096),
 mailbox_binding text CHECK(mailbox_binding IS NULL OR mailbox_binding ~ '^[a-f0-9]{64}$'),
 sequence_binding text CHECK(sequence_binding IS NULL OR sequence_binding ~ '^[a-f0-9]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,sequence_version_id) REFERENCES sequence_versions(workspace_id,id),
 CHECK((owner_user_id IS NULL AND mailbox_id IS NULL AND sequence_version_id IS NULL AND evaluation IS NULL AND mailbox_binding IS NULL AND sequence_binding IS NULL)
 OR (owner_user_id IS NOT NULL AND mailbox_id IS NOT NULL AND sequence_version_id IS NOT NULL AND mailbox_binding IS NOT NULL AND sequence_binding IS NOT NULL)),
 CHECK(NOT enabled)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON outreach_email_admission_settings TO app_runtime,migration;
