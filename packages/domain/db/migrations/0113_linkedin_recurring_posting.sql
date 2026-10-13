-- changes: linkedin_recurring_slots, social_post_approvals
-- Persistent target identity never contains policy revision: policy edits cannot reset cadence.
CREATE TABLE linkedin_recurring_slots (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES users(id),account_id uuid NOT NULL,account_revision integer NOT NULL CHECK(account_revision>0),
 policy_revision integer NOT NULL CHECK(policy_revision>0),target_at timestamptz NOT NULL,
 source_selection jsonb,source_hash text CHECK(source_hash ~ '^[a-f0-9]{64}$'),draft_request_id uuid,post_id uuid,
 state text NOT NULL CHECK(state IN ('pending','drafted','review','skipped','queued')),reason text CHECK(length(reason)<=200),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,account_id,target_at),UNIQUE(workspace_id,id,post_id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES social_accounts(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id,policy_revision) REFERENCES linkedin_posting_policy_revisions(workspace_id,owner_user_id,revision),
 FOREIGN KEY(workspace_id,draft_request_id) REFERENCES social_draft_requests(workspace_id,id),
 FOREIGN KEY(workspace_id,post_id) REFERENCES social_posts(workspace_id,id),
 CHECK(extract(isodow FROM target_at AT TIME ZONE 'America/New_York') IN (2,4) AND (target_at AT TIME ZONE 'America/New_York')::time=time '10:00:00'),
 CHECK(source_selection IS NULL OR (jsonb_typeof(source_selection)='object' AND source_selection->>'mode'='linkedin_grounded' AND octet_length(source_selection::text)<=8192)),
 CHECK((source_selection IS NULL)=(source_hash IS NULL)),
 CHECK(state NOT IN ('pending','drafted','queued') OR (source_hash IS NOT NULL AND draft_request_id IS NOT NULL)),
 CHECK(state<>'queued' OR post_id IS NOT NULL)
);
GRANT SELECT,INSERT ON linkedin_recurring_slots TO app_runtime,migration;
GRANT UPDATE(state,reason,draft_request_id,post_id,updated_at) ON linkedin_recurring_slots TO app_runtime,migration;
ALTER TABLE social_post_approvals ALTER COLUMN approved_by DROP NOT NULL,
 ADD COLUMN approval_kind text NOT NULL DEFAULT 'manual',
 ADD COLUMN standing_slot_id uuid,
 ADD CONSTRAINT social_approval_origin CHECK((approval_kind='manual' AND approved_by IS NOT NULL AND standing_slot_id IS NULL) OR (approval_kind='standing_policy' AND approved_by IS NULL AND standing_slot_id IS NOT NULL)),
 ADD CONSTRAINT social_approval_standing_slot_fk FOREIGN KEY(workspace_id,standing_slot_id,post_id) REFERENCES linkedin_recurring_slots(workspace_id,id,post_id);
