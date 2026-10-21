-- changes: sourcing_candidate_discovery_origins, sourcing_discovery_promotions
-- Preparation lineage only. No source bodies, native observations or contact authority.
ALTER TABLE sourcing_candidate_discovery_origins ADD CONSTRAINT sourcing_discovery_origin_candidate_identity
  UNIQUE(workspace_id,candidate_id,provider,release,record_id);

CREATE TABLE sourcing_discovery_promotions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  raw_candidate_id uuid NOT NULL,
  raw_candidate_revision integer NOT NULL,
  legacy_candidate_id uuid NOT NULL,
  legacy_candidate_revision integer NOT NULL,
  provider text NOT NULL,
  release text NOT NULL,
  record_id text NOT NULL,
  input_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,raw_candidate_id),
  FOREIGN KEY(workspace_id,raw_candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,legacy_candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,raw_candidate_id,provider,release,record_id)
    REFERENCES sourcing_candidate_discovery_origins(workspace_id,candidate_id,provider,release,record_id) ON DELETE CASCADE,
  CONSTRAINT sourcing_discovery_promotion_revisions CHECK(raw_candidate_revision>0 AND legacy_candidate_revision>0),
  CONSTRAINT sourcing_discovery_promotion_digest CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT sourcing_discovery_promotion_distinct CHECK(raw_candidate_id<>legacy_candidate_id)
);
CREATE INDEX sourcing_discovery_promotions_legacy ON sourcing_discovery_promotions(workspace_id,legacy_candidate_id);
-- Append-only lineage. Parent/source deletion cascades, no independent evidence cache.
GRANT SELECT,INSERT,DELETE ON sourcing_discovery_promotions TO app_runtime,migration;
