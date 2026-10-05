-- One shared provider account. Provision explicitly after reconciling prior usage.
CREATE TABLE sourcing_search_account (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 halted boolean NOT NULL DEFAULT false,
 day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
 month date NOT NULL DEFAULT date_trunc('month',now() AT TIME ZONE 'UTC')::date,
 daily_used integer NOT NULL DEFAULT 0 CHECK (daily_used>=0),
 monthly_used integer NOT NULL DEFAULT 0 CHECK (monthly_used>=0)
);
CREATE TABLE sourcing_discovery_settings (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
 enabled boolean NOT NULL DEFAULT false,
 next_run_at timestamptz NOT NULL DEFAULT now(),
 query_cursor integer NOT NULL DEFAULT 0 CHECK (query_cursor>=0),
 last_result text
);
CREATE INDEX sourcing_discovery_due ON sourcing_discovery_settings(next_run_at) WHERE enabled;
CREATE TABLE sourcing_discovery_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
 request_id text,
 query_id text NOT NULL,
 query text NOT NULL CHECK (length(query)<=400),
 state text NOT NULL DEFAULT 'dispatched' CHECK (state IN ('dispatched','complete','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,day)
);
CREATE TABLE sourcing_discovery_hits (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 source_url text NOT NULL CHECK (length(source_url)<=500),
 attempt_id uuid NOT NULL REFERENCES sourcing_discovery_attempts(id),
 candidate_id uuid,
 retrieved_at timestamptz NOT NULL DEFAULT now(),
 native_result jsonb NOT NULL DEFAULT '{}'::jsonb,
 PRIMARY KEY(workspace_id,source_url)
);
GRANT SELECT,INSERT,UPDATE ON sourcing_search_account,sourcing_discovery_settings,sourcing_discovery_attempts,sourcing_discovery_hits TO app_runtime,migration;
