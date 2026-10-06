-- changes: none
-- No authorization is created by migration; only an authenticated admin can opt in.
CREATE TABLE gmail_prospecting_authorizations (
 workspace_id uuid NOT NULL,
 mailbox_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 provider_account_id text NOT NULL CHECK(length(provider_account_id) BETWEEN 1 AND 320),
 email_address text NOT NULL CHECK(length(email_address) BETWEEN 3 AND 320),
 revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT false,
 basis text NOT NULL CHECK(basis='owner_reported_google_permission'),
 reported_by uuid NOT NULL,
 enabled_at timestamptz,
 revoked_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,mailbox_id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,reported_by) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT prospecting_authorization_state CHECK((enabled AND enabled_at IS NOT NULL AND revoked_at IS NULL) OR (NOT enabled AND revoked_at IS NOT NULL))
);
CREATE TABLE outreach_fence_authorizations (
 workspace_id uuid NOT NULL,
 fence_id uuid NOT NULL,
 mailbox_id uuid NOT NULL,
 authorization_revision integer NOT NULL CHECK(authorization_revision>0),
 PRIMARY KEY(workspace_id,fence_id),
 FOREIGN KEY(workspace_id,fence_id) REFERENCES outbound_messages(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES gmail_prospecting_authorizations(workspace_id,mailbox_id) ON DELETE CASCADE
);
GRANT SELECT,INSERT,UPDATE,DELETE ON gmail_prospecting_authorizations,outreach_fence_authorizations TO app_runtime,migration;

CREATE TABLE outreach_answer_blocks (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 current_version integer NOT NULL CHECK(current_version>0),
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE outreach_answer_block_versions (
 workspace_id uuid NOT NULL,
 block_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 kind text NOT NULL CHECK(kind IN ('product','pricing','booking','material')),
 text text NOT NULL CHECK(length(btrim(text)) BETWEEN 1 AND 4000),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 approved_by uuid,
 approved_at timestamptz,
 retired_at timestamptz,
 PRIMARY KEY(workspace_id,block_id,version),
 FOREIGN KEY(workspace_id,block_id) REFERENCES outreach_answer_blocks(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,created_by) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,approved_by) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT answer_block_approval_pair CHECK((approved_at IS NULL)=(approved_by IS NULL))
);
GRANT SELECT,INSERT,UPDATE,DELETE ON outreach_answer_blocks TO app_runtime,migration;
GRANT SELECT,INSERT,DELETE ON outreach_answer_block_versions TO app_runtime,migration;
GRANT UPDATE(approved_by,approved_at,retired_at) ON outreach_answer_block_versions TO app_runtime,migration;
CREATE TABLE outreach_email_sources (
 workspace_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 run_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 route_id uuid NOT NULL,
 observation_id uuid NOT NULL,
 block_id text NOT NULL CHECK(length(block_id) BETWEEN 1 AND 80),
 identity_kind text NOT NULL CHECK(identity_kind IN ('named','role')),
 reviewed boolean NOT NULL,
 association_review_required boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,candidate_id),
 FOREIGN KEY(workspace_id,candidate_id,run_id) REFERENCES sourcing_qualification_runs(workspace_id,candidate_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,route_id) REFERENCES email_addresses(workspace_id,id) ON DELETE CASCADE
);
GRANT SELECT,INSERT,UPDATE,DELETE ON outreach_email_sources TO app_runtime,migration;
