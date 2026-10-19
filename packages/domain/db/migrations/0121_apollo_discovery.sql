-- Apollo is disabled until an owner explicitly configures an exclusive, verified
-- free allowance. This is separate from every Tavily counter/settings row.
-- One opaque account reference identifies the real shared Apollo account. Setup
-- serializes on that reference and forbids overlapping cycles or resetting usage.
CREATE TABLE sourcing_apollo_allowances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_ref text NOT NULL CHECK (length(account_ref) BETWEEN 1 AND 120),
 key_ref text NOT NULL CHECK (length(key_ref) BETWEEN 1 AND 120),
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 cycle_start timestamptz NOT NULL,
 cycle_end timestamptz NOT NULL,
 verified_at timestamptz NOT NULL,
 exclusive_attested_at timestamptz NOT NULL,
 starting_used smallint NOT NULL CHECK (starting_used BETWEEN 0 AND 75),
 reserved smallint NOT NULL DEFAULT 0 CHECK (reserved BETWEEN 0 AND 75),
 enabled boolean NOT NULL DEFAULT false,
 halted boolean NOT NULL DEFAULT false,
 next_run_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (account_ref,cycle_start),
 UNIQUE (workspace_id,id),
 CHECK (cycle_end>cycle_start),
 CHECK (cycle_start<=verified_at AND verified_at<cycle_end),
 CHECK (cycle_start<=exclusive_attested_at AND exclusive_attested_at<cycle_end),
 CHECK (starting_used+reserved<=75)
);
-- Rows count BEFORE the request leaves. Unknown/failed requests are never
-- refunded or retried. A new cycle is explicit, not a calendar reset.
CREATE TABLE sourcing_apollo_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 allowance_id uuid NOT NULL,
 region text NOT NULL CHECK (region IN ('TX','RI','MA')),
 page integer NOT NULL CHECK (page BETWEEN 1 AND 100000),
 state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','complete','failed','unknown')),
 request_id text CHECK (request_id IS NULL OR length(request_id)<=200),
 failure_code text CHECK (failure_code IS NULL OR length(failure_code)<=80),
 returned_count smallint CHECK (returned_count BETWEEN 0 AND 100),
 created_count smallint CHECK (created_count BETWEEN 0 AND 100),
 reserved_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE (workspace_id,id),
 UNIQUE (allowance_id,region,page),
 FOREIGN KEY (workspace_id,allowance_id) REFERENCES sourcing_apollo_allowances(workspace_id,id)
);
CREATE INDEX sourcing_apollo_pending ON sourcing_apollo_attempts(allowance_id,reserved_at) WHERE state IN ('reserved','unknown');
-- Strict client candidate payloads remain unchanged. Only these organization
-- fields survive the Apollo adapter. No raw response, people or contact fields.
-- Provenance is not first-party qualification evidence or contact permission.
CREATE TABLE sourcing_apollo_candidate_origins (
 workspace_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 candidate_revision integer NOT NULL CHECK (candidate_revision>0),
 attempt_id uuid NOT NULL,
 organization_name text NOT NULL CHECK (length(organization_name) BETWEEN 1 AND 300),
 domain text NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
 hq_city text CHECK (hq_city IS NULL OR length(hq_city)<=150),
 hq_state text CHECK (hq_state IS NULL OR hq_state IN ('TX','RI','MA')),
 employee_count smallint CHECK (employee_count BETWEEN 1 AND 10),
 PRIMARY KEY (workspace_id,candidate_id,candidate_revision),
 FOREIGN KEY (workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY (workspace_id,attempt_id) REFERENCES sourcing_apollo_attempts(workspace_id,id)
);
GRANT SELECT,INSERT,UPDATE ON sourcing_apollo_allowances,sourcing_apollo_attempts TO app_runtime,migration;
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_apollo_candidate_origins TO app_runtime,migration;
