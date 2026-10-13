-- changes: linkedin_posting_settings, linkedin_posting_policy_revisions, linkedin_posting_candidate_bindings
-- Separate posting authority. No private inputs, credentials or Enable.
CREATE TABLE linkedin_posting_settings (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),owner_user_id uuid NOT NULL REFERENCES users(id),
 revision integer NOT NULL CHECK(revision>0),state text NOT NULL CHECK(state IN ('saved','disabled','revoked')),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,owner_user_id)
);
CREATE TABLE linkedin_posting_policy_revisions (
 workspace_id uuid NOT NULL,owner_user_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('saved','disabled','revoked')),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,owner_user_id,revision),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES linkedin_posting_settings(workspace_id,owner_user_id)
);
GRANT SELECT,INSERT,UPDATE ON linkedin_posting_settings TO app_runtime,migration;
GRANT SELECT,INSERT ON linkedin_posting_policy_revisions TO app_runtime,migration;
CREATE TABLE linkedin_posting_candidate_bindings (
 workspace_id uuid NOT NULL,delivery_id uuid NOT NULL,owner_user_id uuid NOT NULL,policy_revision integer NOT NULL,
 PRIMARY KEY(workspace_id,delivery_id),
 CONSTRAINT posting_candidate_delivery_fk FOREIGN KEY(workspace_id,delivery_id) REFERENCES social_deliveries(workspace_id,id),
 CONSTRAINT posting_candidate_policy_fk FOREIGN KEY(workspace_id,owner_user_id,policy_revision) REFERENCES linkedin_posting_policy_revisions(workspace_id,owner_user_id,revision)
);
GRANT SELECT,INSERT ON linkedin_posting_candidate_bindings TO app_runtime,migration;
