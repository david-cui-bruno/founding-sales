-- changes: sourcing_experiments, sourcing_experiment_revisions, sourcing_experiment_activations
CREATE TABLE sourcing_experiments (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), status text NOT NULL CHECK(status IN ('accepted','dismissed','erased')),
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE sourcing_experiment_revisions (
 workspace_id uuid NOT NULL, id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=16384),
 report jsonb NOT NULL CHECK(jsonb_typeof(report)='object' AND octet_length(report::text)<=262144),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id,revision),
 FOREIGN KEY(workspace_id,id) REFERENCES sourcing_experiments(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,created_by) REFERENCES workspace_memberships(workspace_id,user_id)
);
CREATE TABLE sourcing_experiment_activations (
 workspace_id uuid NOT NULL, id uuid NOT NULL, revision integer NOT NULL,
 activation_id uuid NOT NULL DEFAULT gen_random_uuid(), result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=4096),
 started_at timestamptz NOT NULL DEFAULT now(), stopped_at timestamptz, stop_reason text,
 PRIMARY KEY(workspace_id,activation_id),
 FOREIGN KEY(workspace_id,id) REFERENCES sourcing_experiments(workspace_id,id),
 CHECK((stopped_at IS NULL)=(stop_reason IS NULL))
);
CREATE UNIQUE INDEX sourcing_experiment_one_active ON sourcing_experiment_activations(workspace_id) WHERE stopped_at IS NULL;
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_experiments TO app_runtime,migration;
GRANT SELECT,INSERT,DELETE ON sourcing_experiment_revisions TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_experiment_revisions TO migration;
GRANT SELECT,INSERT,UPDATE ON sourcing_experiment_activations TO app_runtime,migration;
