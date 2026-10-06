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

CREATE TABLE meeting_qualification_revisions (
 workspace_id uuid NOT NULL,
 meeting_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 revision integer NOT NULL,
 buying_participant text NOT NULL,
 maintenance_need text NOT NULL,
 open_to_paying text NOT NULL,
 evidence jsonb NOT NULL,
 command_id text NOT NULL,
 created_by_user_id uuid NOT NULL,
 original_meeting_id uuid,
 original_revision integer,
 invalidated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,meeting_id,revision),
 UNIQUE(workspace_id,command_id),
 FOREIGN KEY(workspace_id,meeting_id,firm_id) REFERENCES meetings(workspace_id,id,firm_id) ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY(workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT meeting_qualification_revision CHECK(revision>0),
 CONSTRAINT meeting_qualification_answers CHECK(buying_participant IN ('yes','no','unknown') AND maintenance_need IN ('yes','no','unknown') AND open_to_paying IN ('yes','no','unknown')),
 CONSTRAINT meeting_qualification_evidence CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)<=3 AND octet_length(evidence::text)<=4096),
 CONSTRAINT meeting_qualification_command CHECK(command_id ~ '^[0-9a-zA-Z_:-]{1,128}$')
);
GRANT SELECT,INSERT,UPDATE,DELETE ON meeting_qualification_revisions TO app_runtime,migration;
