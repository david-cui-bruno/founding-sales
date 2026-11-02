-- changes: sourcing_callable_ranks
-- ADR0034: an advisory order key for "Callable today", never a fact about the company. One row per candidate holds the
-- projected callable rank (NULL: checked, not callable) and company host as the prepared projection last saw them, so
-- the list can order callable companies across all pages. The list re-projects every page it shows, so a stale row can
-- only misorder; it stores no source text, phone or person, and it grants nothing. It is bound to the exact candidate
-- revision and latest run, expires within eight days, and is deleted when its run's evidence changes.
CREATE TABLE sourcing_callable_ranks (
 workspace_id uuid NOT NULL, candidate_id uuid NOT NULL, candidate_revision integer NOT NULL CHECK(candidate_revision>0),
 run_id uuid NOT NULL, rank smallint CHECK(rank BETWEEN 0 AND 15), company_host text CHECK(company_host IS NULL OR length(company_host) BETWEEN 1 AND 253),
 computed_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,candidate_id),
 FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,candidate_id,run_id) REFERENCES sourcing_qualification_runs(workspace_id,candidate_id,id) ON DELETE CASCADE,
 CHECK(expires_at>computed_at AND expires_at<=computed_at+interval '8 days')
);
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_callable_ranks TO app_runtime,migration;
CREATE FUNCTION sourcing_callable_rank_run_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM sourcing_callable_ranks WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.candidate_id AND run_id=OLD.id;
 RETURN NEW;
END $$;
CREATE TRIGGER sourcing_callable_rank_run_lifecycle BEFORE UPDATE OF candidate_revision,state,reason,observations,facts,prepared_identity,prepared_capture ON sourcing_qualification_runs
 FOR EACH ROW EXECUTE FUNCTION sourcing_callable_rank_run_lifecycle();
