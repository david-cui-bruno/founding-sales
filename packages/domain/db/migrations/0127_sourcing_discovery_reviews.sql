-- changes: sourcing_candidate_discovery_reviews
-- Human-reviewed service signals only. No qualification, admission or outreach authority.
CREATE TABLE sourcing_candidate_discovery_reviews (
  workspace_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  candidate_revision integer NOT NULL,
  review_version text NOT NULL,
  evidence jsonb NOT NULL,
  assessment jsonb NOT NULL,
  content_digest text NOT NULL,
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT sourcing_discovery_review_revision CHECK (candidate_revision > 0),
  CONSTRAINT sourcing_discovery_review_version CHECK (review_version = 'discovery-review-v1'),
  CONSTRAINT sourcing_discovery_review_digest CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT sourcing_discovery_review_evidence CHECK ((
    jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 8
    AND octet_length(evidence::text) <= 32768
  ) IS TRUE),
  CONSTRAINT sourcing_discovery_review_assessment CHECK ((
    jsonb_typeof(assessment) = 'object' AND octet_length(assessment::text) <= 8192
    AND assessment->>'serviceSignal' IN ('paragraph_supported','tentative','unknown','contradicted')
    AND assessment->>'websiteAssociation' IN ('unknown','supported','ambiguous')
    AND jsonb_typeof(assessment->'unknowns') = 'array'
    AND jsonb_array_length(assessment->'unknowns') <= 30
    AND (assessment - ARRAY['serviceSignal','websiteAssociation','unknowns']) = '{}'::jsonb
  ) IS TRUE),
  UNIQUE (workspace_id,candidate_id,candidate_revision,review_version,content_digest)
);
CREATE INDEX sourcing_discovery_reviews_current
  ON sourcing_candidate_discovery_reviews(workspace_id,candidate_id,candidate_revision,reviewed_at DESC,id DESC);
-- Append-only. Candidate deletion erases excerpts. No independent evidence cache.
GRANT SELECT,INSERT,DELETE ON sourcing_candidate_discovery_reviews TO app_runtime,migration;
