-- changes: sourcing_discovery_settings, sourcing_discovery_attempts
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

CREATE TABLE sourcing_targeting_versions (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 version text NOT NULL CHECK(length(version) BETWEEN 1 AND 80),
 queries jsonb NOT NULL CHECK(jsonb_typeof(queries)='array' AND jsonb_array_length(queries) BETWEEN 1 AND 30 AND octet_length(queries::text)<=32768),
 rank_order jsonb NOT NULL CHECK(jsonb_typeof(rank_order)='array' AND jsonb_array_length(rank_order)=4 AND rank_order @> '["help_request","operational_burden","investigation","fit_only"]'::jsonb),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,version)
);
CREATE TABLE sourcing_targeting_proposals (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 base_version text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='object' AND octet_length(changes::text)<=49152),
 applied_version text,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 applied_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,base_version) REFERENCES sourcing_targeting_versions(workspace_id,version),
 FOREIGN KEY(workspace_id,applied_version) REFERENCES sourcing_targeting_versions(workspace_id,version),
 FOREIGN KEY(workspace_id,created_by) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT targeting_application_pair CHECK((applied_version IS NULL)=(applied_at IS NULL))
);
ALTER TABLE sourcing_discovery_settings ADD COLUMN targeting_version text,
 ADD CONSTRAINT discovery_targeting_version FOREIGN KEY(workspace_id,targeting_version) REFERENCES sourcing_targeting_versions(workspace_id,version);
ALTER TABLE sourcing_discovery_attempts ADD COLUMN policy_version text,
 ADD CONSTRAINT discovery_attempt_policy FOREIGN KEY(workspace_id,policy_version) REFERENCES sourcing_targeting_versions(workspace_id,version);
-- Old attempts intentionally retain null: their query text is known, their policy version wasn't recorded.
GRANT SELECT,INSERT ON sourcing_targeting_versions TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_targeting_versions TO migration;
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_targeting_proposals TO app_runtime,migration;

-- Preserve the current search set for workspaces that exist at upgrade.
INSERT INTO sourcing_targeting_versions(workspace_id,version,queries,rank_order)
 SELECT id,'targeting-v1','[{"id": "dfw-simple-v3", "query": "Dallas Fort Worth residential property management", "locality": "DFW", "region": "TX"}, {"id": "providence-simple-v3", "query": "Providence Rhode Island property management", "locality": "Providence", "region": "RI"}, {"id": "boston-simple-v3", "query": "Boston residential property management", "locality": "Boston", "region": "MA"}, {"id": "arlington-simple-v3", "query": "Arlington Texas residential property management", "locality": "Arlington", "region": "TX"}, {"id": "plano-simple-v3", "query": "Plano Texas residential property management", "locality": "Plano", "region": "TX"}, {"id": "frisco-simple-v3", "query": "Frisco Texas residential property management", "locality": "Frisco", "region": "TX"}, {"id": "denton-simple-v3", "query": "Denton Texas residential property management", "locality": "Denton", "region": "TX"}, {"id": "warwick-simple-v3", "query": "Warwick Rhode Island property management", "locality": "Warwick", "region": "RI"}, {"id": "cranston-simple-v3", "query": "Cranston Rhode Island property management", "locality": "Cranston", "region": "RI"}, {"id": "cambridge-simple-v3", "query": "Cambridge Massachusetts residential property management", "locality": "Cambridge", "region": "MA"}, {"id": "somerville-simple-v3", "query": "Somerville Massachusetts residential property management", "locality": "Somerville", "region": "MA"}, {"id": "quincy-simple-v3", "query": "Quincy Massachusetts residential property management", "locality": "Quincy", "region": "MA"}]'::jsonb,'["help_request","operational_burden","investigation","fit_only"]'::jsonb FROM workspaces;
UPDATE sourcing_discovery_settings SET targeting_version='targeting-v1';

-- Explicit, optional confirmation on the actual call. No meeting or deal is needed.
CREATE TABLE call_need_revisions (
 workspace_id uuid NOT NULL,
 call_log_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 source_revision integer NOT NULL CHECK(source_revision>=0),
 source_outcome text NOT NULL,
 answer text NOT NULL CHECK(answer IN ('yes','no','unknown')),
 command_id text NOT NULL CHECK(command_id ~ '^[0-9a-zA-Z_:-]{1,128}$'),
 confirmed_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,call_log_id,revision),
 UNIQUE(workspace_id,command_id),
 FOREIGN KEY(workspace_id,call_log_id) REFERENCES call_logs(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,confirmed_by) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,DELETE ON call_need_revisions TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON call_need_revisions TO migration;
