-- changes: sourcing_qualification_runs
CREATE TABLE sourcing_retained_identity_decisions (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 original_run_id uuid NOT NULL,
 original_revision integer NOT NULL CHECK(original_revision>0),
 result_revision integer NOT NULL CHECK(result_revision>=original_revision),
 reviewer_user_id uuid NOT NULL,
 observation_id uuid NOT NULL,
 block_id text NOT NULL CHECK(length(block_id) BETWEEN 1 AND 80),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 relevant_text_hash text NOT NULL CHECK(relevant_text_hash ~ '^[a-f0-9]{64}$'),
 name_start integer NOT NULL CHECK(name_start>=0),
 name_end integer NOT NULL CHECK(name_end>name_start AND name_end<=2000),
 method_version text NOT NULL DEFAULT 'human-retained-v1' CHECK(method_version='human-retained-v1'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,candidate_id,id),
 UNIQUE(workspace_id,candidate_id,original_run_id),
 FOREIGN KEY(workspace_id,candidate_id,original_run_id) REFERENCES sourcing_qualification_runs(workspace_id,candidate_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,reviewer_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,DELETE ON sourcing_retained_identity_decisions TO app_runtime,migration;
ALTER TABLE sourcing_qualification_runs ADD COLUMN retained_identity_decision_id uuid;
ALTER TABLE sourcing_qualification_runs ADD CONSTRAINT sourcing_retained_run_decision
 FOREIGN KEY(workspace_id,candidate_id,retained_identity_decision_id) REFERENCES sourcing_retained_identity_decisions(workspace_id,candidate_id,id) ON DELETE CASCADE;
CREATE UNIQUE INDEX sourcing_retained_one_interpretation ON sourcing_qualification_runs(workspace_id,retained_identity_decision_id) WHERE retained_identity_decision_id IS NOT NULL;
CREATE TABLE sourcing_retained_firm_acquisition_fences (
 workspace_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 decision_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,firm_id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id) ON DELETE CASCADE
);
GRANT SELECT,INSERT,DELETE ON sourcing_retained_firm_acquisition_fences TO app_runtime,migration;
