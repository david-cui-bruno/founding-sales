-- changes: sourcing_manual_prospect_states
-- Reversible manual pruning only, with no canonical candidate or outreach authority.
CREATE TABLE sourcing_manual_prospect_states (
 workspace_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 candidate_revision integer NOT NULL,
 state text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id,candidate_id),
 CONSTRAINT sourcing_manual_prospect_candidate_fk FOREIGN KEY (workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
 CONSTRAINT sourcing_manual_prospect_revision CHECK (candidate_revision > 0),
 CONSTRAINT sourcing_manual_prospect_state CHECK (state IN ('kept','skipped','wrong_number'))
);
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_manual_prospect_states TO app_runtime,migration;
