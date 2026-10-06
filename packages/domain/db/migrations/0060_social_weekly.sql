-- changes: social_draft_requests
CREATE TABLE social_weekly_settings (
 workspace_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT false,
 next_at timestamptz,
 last_at timestamptz,
 last_result text CHECK(last_result IN ('queued','no_new_sources','sources_unavailable','requests_pending')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,owner_user_id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK(enabled=(next_at IS NOT NULL))
);
CREATE INDEX social_weekly_due ON social_weekly_settings(next_at) WHERE enabled;
ALTER TABLE social_draft_requests ADD COLUMN weekly_revision integer CHECK(weekly_revision>0);
GRANT SELECT,INSERT,UPDATE,DELETE ON social_weekly_settings TO app_runtime,migration;
