-- Additive learning references. No permission, enrollment, or stage changes.
CREATE TABLE sourcing_attributions (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 firm_id uuid NOT NULL,
 candidate_id uuid,
 run_id uuid,
 source_key text NOT NULL,
 query_id text,
 hypothesis text NOT NULL,
 policy_version text NOT NULL,
 acquisition text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE SET NULL(candidate_id),
 FOREIGN KEY(workspace_id,run_id) REFERENCES sourcing_qualification_runs(workspace_id,id) ON DELETE SET NULL(run_id),
 UNIQUE(workspace_id,firm_id,source_key),
 CONSTRAINT sourcing_attribution_acquisition CHECK(acquisition IN ('cold_sourced','warm_intro','manual','unknown')),
 CONSTRAINT sourcing_attribution_codes CHECK(length(source_key) BETWEEN 1 AND 200 AND length(hypothesis) BETWEEN 1 AND 80 AND length(policy_version) BETWEEN 1 AND 80 AND (query_id IS NULL OR length(query_id) BETWEEN 1 AND 100))
);
CREATE TABLE sourcing_interactions (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 attribution_id uuid NOT NULL,
 kind text NOT NULL,
 subject_id uuid NOT NULL,
 source_revision integer NOT NULL,
 occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 outbound boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,attribution_id) REFERENCES sourcing_attributions(workspace_id,id) ON DELETE CASCADE,
 UNIQUE(workspace_id,kind,subject_id,source_revision),
 CONSTRAINT sourcing_interaction_kind CHECK(kind IN ('call','email','meeting','deal')),
 CONSTRAINT sourcing_interaction_revision CHECK(source_revision>=0)
);
CREATE TABLE sourcing_first_touches (
 workspace_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 attribution_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,firm_id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,attribution_id) REFERENCES sourcing_attributions(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX sourcing_interactions_by_source ON sourcing_interactions(workspace_id,attribution_id,occurred_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_attributions,sourcing_interactions,sourcing_first_touches TO app_runtime,migration;
