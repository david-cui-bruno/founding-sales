CREATE TABLE social_accounts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL REFERENCES users(id),
 platform text NOT NULL CHECK(platform IN ('linkedin','facebook','x')), external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 300),display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
 account_kind text NOT NULL CHECK(account_kind IN ('profile','page')),state text NOT NULL DEFAULT 'unsupported' CHECK(state IN ('connected','reconnect','unsupported','disconnected')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),adapter_version text,verified_at timestamptz,max_schedule_days integer CHECK(max_schedule_days BETWEEN 1 AND 365),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,owner_user_id,platform,external_id)
);
CREATE TABLE social_posts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL REFERENCES users(id),current_revision integer NOT NULL DEFAULT 1 CHECK(current_revision>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE social_post_revisions (
 workspace_id uuid NOT NULL,post_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),account_id uuid NOT NULL,
 text text NOT NULL CHECK(length(text) BETWEEN 1 AND 10000),images jsonb NOT NULL DEFAULT '[]',publish_at timestamptz,zone text NOT NULL,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','approved','submitting','scheduled','published','cancellation_pending','cancelled','failed','unknown')),
 reason text,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,post_id,revision),
 FOREIGN KEY(workspace_id,post_id) REFERENCES social_posts(workspace_id,id),FOREIGN KEY(workspace_id,account_id) REFERENCES social_accounts(workspace_id,id)
);
CREATE TABLE social_post_approvals (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),post_id uuid NOT NULL,revision integer NOT NULL,
 account_revision integer NOT NULL,fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),snapshot jsonb NOT NULL,
 approved_by uuid NOT NULL REFERENCES users(id),approved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,post_id,revision),FOREIGN KEY(workspace_id,post_id,revision) REFERENCES social_post_revisions(workspace_id,post_id,revision)
);
CREATE TABLE social_deliveries (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),post_id uuid NOT NULL,revision integer NOT NULL,approval_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','preparing','submitting','scheduled','published','cancellation_pending','cancelled','failed','unknown')),
 claim_id uuid,device_id uuid,claim_expires_at timestamptz,submission_id uuid,submitted_at timestamptz,
 receipt_id text,permalink text,observed_at timestamptz,next_inspection_at timestamptz,inspection_deadline timestamptz,inspection_attempts integer NOT NULL DEFAULT 0 CHECK(inspection_attempts>=0),reason text,
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,post_id,revision),UNIQUE(workspace_id,submission_id),
 FOREIGN KEY(workspace_id,post_id,revision) REFERENCES social_post_revisions(workspace_id,post_id,revision),FOREIGN KEY(workspace_id,approval_id) REFERENCES social_post_approvals(workspace_id,id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON social_accounts,social_posts,social_post_revisions,social_deliveries TO app_runtime,migration;
GRANT SELECT,INSERT ON social_post_approvals TO app_runtime,migration;
