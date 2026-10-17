-- changes: linkedin_outreach_settings, linkedin_outreach_policy_revisions
-- Owner settings only. No provider evidence, work dispatch or Enable is created.
CREATE TABLE linkedin_outreach_settings (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),owner_user_id uuid NOT NULL REFERENCES users(id),
 revision integer NOT NULL CHECK(revision>0),state text NOT NULL CHECK(state IN ('saved','disabled','revoked')),
 approved boolean NOT NULL DEFAULT false,approved_at timestamptz,
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,owner_user_id),
 CHECK((state='saved' AND approved AND approved_at IS NOT NULL) OR (state IN ('disabled','revoked') AND NOT approved AND approved_at IS NULL))
);
CREATE TABLE linkedin_outreach_policy_revisions (
 workspace_id uuid NOT NULL,owner_user_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('saved','disabled','revoked')),approved boolean NOT NULL,
 approved_at timestamptz,policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,owner_user_id,revision),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES linkedin_outreach_settings(workspace_id,owner_user_id)
);
GRANT SELECT,INSERT,UPDATE ON linkedin_outreach_settings TO app_runtime,migration;
GRANT SELECT,INSERT ON linkedin_outreach_policy_revisions TO app_runtime,migration;
