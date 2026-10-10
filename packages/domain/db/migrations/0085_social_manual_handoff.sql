-- changes: social_manual_handoff_approvals
-- Manual review only: no provider dispatch, adapter grant or social delivery.
CREATE TABLE social_manual_handoff_approvals (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 post_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=65536),
 approved_by uuid NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,post_id,revision,fingerprint),
 FOREIGN KEY(workspace_id,post_id,revision) REFERENCES social_post_revisions(workspace_id,post_id,revision),
 FOREIGN KEY(workspace_id,approved_by) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT ON social_manual_handoff_approvals TO app_runtime,migration;
