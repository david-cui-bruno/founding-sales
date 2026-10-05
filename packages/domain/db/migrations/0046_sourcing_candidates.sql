-- Additive: unverified candidate drafts, separate from callable firms and deals.
-- Admin deletion removes a draft; keeping/dismissing is triage, not verification.
CREATE TABLE sourcing_candidates (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identity_key text NOT NULL CHECK (char_length(identity_key) = 64),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 20000),
  status text NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review','kept','dismissed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,identity_key)
);
CREATE INDEX sourcing_candidates_review ON sourcing_candidates(workspace_id,status,created_at DESC,id DESC);
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_candidates TO app_runtime,migration;
