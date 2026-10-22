-- changes: sourcing_automatic_research_firms
-- Private lineage only, never copied evidence, promotion, enrollment or dispatch authority.
CREATE TABLE sourcing_automatic_research_firms (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 candidate_id uuid NOT NULL,
 run_id uuid NOT NULL,
 candidate_revision integer NOT NULL CHECK(candidate_revision>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 firm_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('search_hit','apollo_organization')),
 source_url text NOT NULL,
 source_attempt_id uuid NOT NULL,
 search_source_url text,
 search_attempt_id uuid REFERENCES sourcing_discovery_attempts(id) ON DELETE CASCADE,
 apollo_origin_revision integer,
 apollo_attempt_id uuid,
 evidence_fingerprint text NOT NULL CHECK(evidence_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,candidate_id),
 FOREIGN KEY(workspace_id,candidate_id,run_id) REFERENCES sourcing_qualification_runs(workspace_id,candidate_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,search_source_url) REFERENCES sourcing_discovery_hits(workspace_id,source_url) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,candidate_id,apollo_origin_revision) REFERENCES sourcing_apollo_candidate_origins(workspace_id,candidate_id,candidate_revision) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,apollo_attempt_id) REFERENCES sourcing_apollo_attempts(workspace_id,id) ON DELETE CASCADE,
 CHECK((source_kind='search_hit' AND search_source_url IS NOT NULL AND search_attempt_id IS NOT NULL AND search_source_url=source_url AND search_attempt_id=source_attempt_id AND apollo_origin_revision IS NULL AND apollo_attempt_id IS NULL)
 OR (source_kind='apollo_organization' AND search_source_url IS NULL AND search_attempt_id IS NULL AND apollo_origin_revision IS NOT NULL AND apollo_attempt_id IS NOT NULL AND apollo_attempt_id=source_attempt_id))
);
CREATE INDEX sourcing_automatic_research_firm ON sourcing_automatic_research_firms(workspace_id,firm_id);
CREATE FUNCTION automatic_research_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.id,NEW.candidate_id,NEW.firm_id,NEW.owner_user_id,NEW.source_kind,NEW.source_url,NEW.source_attempt_id,NEW.search_source_url,NEW.search_attempt_id,NEW.apollo_origin_revision,NEW.apollo_attempt_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.candidate_id,OLD.firm_id,OLD.owner_user_id,OLD.source_kind,OLD.source_url,OLD.source_attempt_id,OLD.search_source_url,OLD.search_attempt_id,OLD.apollo_origin_revision,OLD.apollo_attempt_id,OLD.created_at)
 OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'automatic research identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automatic_research_identity_immutable BEFORE UPDATE ON sourcing_automatic_research_firms FOR EACH ROW EXECUTE FUNCTION automatic_research_identity_immutable();
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_automatic_research_firms TO app_runtime,migration;
