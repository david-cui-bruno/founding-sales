-- changes: sourcing_candidate_discovery_origins
-- Source observations for the existing unverified candidate queue, not new firms or contact authority.
CREATE TABLE sourcing_candidate_discovery_origins (
  workspace_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  provider text NOT NULL,
  release text NOT NULL,
  record_id text NOT NULL,
  source jsonb NOT NULL,
  source_metadata jsonb NOT NULL,
  licenses jsonb NOT NULL,
  notices jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,provider,release,record_id),
  FOREIGN KEY (workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT sourcing_discovery_origin_source_shape CHECK ((
    provider IN ('overture_places','first_party','apollo_free','public_directory')
    AND length(release) BETWEEN 1 AND 200
    AND length(record_id) BETWEEN 1 AND 500
    AND jsonb_typeof(source) = 'object'
    AND octet_length(source::text) <= 8192
    AND source->>'provider' = provider
    AND source->>'release' = release
    AND source->>'recordId' = record_id
  ) IS TRUE),
  CONSTRAINT sourcing_discovery_origin_metadata_shape CHECK ((
    jsonb_typeof(source_metadata) = 'object'
    AND octet_length(source_metadata::text) <= 8192
    AND jsonb_typeof(source_metadata->'sourcesJson') = 'string'
    AND (source_metadata - 'sourcesJson') = '{}'::jsonb
  ) IS TRUE),
  CONSTRAINT sourcing_discovery_origin_license_shape CHECK ((
    jsonb_typeof(licenses) = 'array'
    AND jsonb_array_length(licenses) BETWEEN 1 AND 16
    AND octet_length(licenses::text) <= 8192
    AND jsonb_typeof(notices) = 'array'
    AND jsonb_array_length(notices) BETWEEN 1 AND 16
    AND octet_length(notices::text) <= 32768
  ) IS TRUE)
);
CREATE INDEX sourcing_discovery_origins_candidate
  ON sourcing_candidate_discovery_origins(workspace_id,candidate_id);
-- Exact source observations are immutable. A changed source tuple is a conflict, not an overwrite.
GRANT SELECT,INSERT,DELETE ON sourcing_candidate_discovery_origins TO app_runtime,migration;
