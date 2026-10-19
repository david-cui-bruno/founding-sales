-- changes: research_runs, evidence_items, firm_office_assessments, firm_office_assessment_sources
-- No jobs/provider calls, settings, routes, contacts or outreach permission change.
-- Legacy runs remain briefs. Strict office evidence is explicit and source-owned.
ALTER TABLE research_runs
  ADD COLUMN purpose text NOT NULL DEFAULT 'brief',
  ADD COLUMN office_assessment_capture_status text,
  ADD COLUMN office_assessment_capture_version text,
  ADD CONSTRAINT research_runs_purpose_known CHECK (purpose IN ('brief','office_evidence')),
  ADD CONSTRAINT research_runs_office_requested CHECK (purpose <> 'office_evidence' OR trigger = 'user_request'),
  ADD CONSTRAINT research_runs_office_no_brief CHECK (purpose <> 'office_evidence' OR (brief IS NULL AND facts_recorded = 0)),
  ADD CONSTRAINT research_runs_office_capture_shape CHECK (
    (office_assessment_capture_status IS NULL AND office_assessment_capture_version IS NULL)
    OR (purpose = 'office_evidence' AND office_assessment_capture_status IS NOT NULL
      AND office_assessment_capture_status IN ('bound','target_missing','target_ambiguous','identity_missing')
      AND office_assessment_capture_version IS NOT NULL AND office_assessment_capture_version = 'office-target-v1')),
  ADD CONSTRAINT research_runs_firm_purpose_key UNIQUE (workspace_id,firm_id,id,purpose);
CREATE INDEX research_runs_by_purpose ON research_runs(workspace_id,firm_id,purpose,revision DESC);
CREATE FUNCTION research_run_purpose_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'Research purpose is immutable' USING ERRCODE = '23514', CONSTRAINT = 'research_run_purpose_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER research_run_purpose_immutable BEFORE UPDATE ON research_runs
  FOR EACH ROW EXECUTE FUNCTION research_run_purpose_immutable();
ALTER TABLE evidence_items ADD CONSTRAINT evidence_items_firm_identity_key UNIQUE (workspace_id,firm_id,id);

-- Body-free binding. Runtime verifies current firm, sole route, exact versions and
-- fingerprint again. A moved route never rebinds the assessment to its survivor.
CREATE TABLE firm_office_assessments (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL,
  research_run_id uuid NOT NULL,
  research_purpose text NOT NULL DEFAULT 'office_evidence',
  phone_route_id uuid NOT NULL,
  route_version integer NOT NULL,
  route_endpoint_hash char(64) NOT NULL,
  firm_identity_fingerprint char(64) NOT NULL,
  identity_version text NOT NULL DEFAULT 'office-identity-v1',
  target_version text NOT NULL DEFAULT 'office-target-v1',
  assessment_version text NOT NULL DEFAULT 'firm-office-assessment-v1',
  selection_version text NOT NULL DEFAULT 'office-select-v1',
  qualification_policy_version text NOT NULL,
  qualification_prompt_version text NOT NULL,
  verified_firm_policy_version text NOT NULL,
  captured_at timestamptz NOT NULL,
  assessed_at timestamptz,
  expires_at timestamptz NOT NULL,
  result text NOT NULL DEFAULT 'pending',
  reason text,
  expected_source_count smallint NOT NULL DEFAULT 0,
  CONSTRAINT office_assessment_pkey PRIMARY KEY (workspace_id,id),
  CONSTRAINT office_assessment_run_key UNIQUE (workspace_id,research_run_id),
  CONSTRAINT office_assessment_firm_key UNIQUE (workspace_id,id,firm_id),
  CONSTRAINT office_assessment_run_fkey FOREIGN KEY (workspace_id,firm_id,research_run_id,research_purpose)
    REFERENCES research_runs(workspace_id,firm_id,id,purpose) ON DELETE CASCADE,
  CONSTRAINT office_assessment_firm_fkey FOREIGN KEY (workspace_id,firm_id) REFERENCES firms(workspace_id,id),
  CONSTRAINT office_assessment_route_fkey FOREIGN KEY (workspace_id,phone_route_id)
    REFERENCES phone_routes(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT office_assessment_purpose CHECK (research_purpose = 'office_evidence'),
  CONSTRAINT office_assessment_route_version CHECK (route_version > 0),
  CONSTRAINT office_assessment_hashes CHECK (route_endpoint_hash ~ '^[0-9a-f]{64}$' AND firm_identity_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT office_assessment_versions CHECK (
    length(btrim(identity_version)) BETWEEN 1 AND 80 AND length(btrim(target_version)) BETWEEN 1 AND 80
    AND length(btrim(assessment_version)) BETWEEN 1 AND 80 AND length(btrim(selection_version)) BETWEEN 1 AND 80
    AND length(btrim(qualification_policy_version)) BETWEEN 1 AND 80
    AND length(btrim(qualification_prompt_version)) BETWEEN 1 AND 80
    AND length(btrim(verified_firm_policy_version)) BETWEEN 1 AND 80),
  CONSTRAINT office_assessment_result CHECK (result IN ('pending','supported','unclear','stale')),
  CONSTRAINT office_assessment_reason CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,119}$'),
  CONSTRAINT office_assessment_source_count CHECK (expected_source_count BETWEEN 0 AND 8),
  CONSTRAINT office_assessment_times CHECK (expires_at > captured_at AND (assessed_at IS NULL OR assessed_at >= captured_at)),
  CONSTRAINT office_assessment_supported CHECK (result <> 'supported' OR (
    assessed_at IS NOT NULL AND reason IS NULL AND expected_source_count BETWEEN 1 AND 8 AND expires_at > assessed_at))
);
CREATE INDEX office_assessments_by_firm ON firm_office_assessments(workspace_id,firm_id,captured_at DESC,id DESC);

-- All copied blocks/facts live here, not in parent/detail/brief/job/log copies.
-- Source erasure cascades. Expected count is never decremented to hide source loss.
CREATE TABLE firm_office_assessment_sources (
  workspace_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  ordinal smallint NOT NULL,
  evidence_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  observation jsonb NOT NULL,
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT office_source_pkey PRIMARY KEY (workspace_id,assessment_id,observation_id),
  CONSTRAINT office_source_ordinal_key UNIQUE (workspace_id,assessment_id,ordinal),
  CONSTRAINT office_source_parent_fkey FOREIGN KEY (workspace_id,assessment_id,firm_id)
    REFERENCES firm_office_assessments(workspace_id,id,firm_id) ON DELETE CASCADE,
  CONSTRAINT office_source_evidence_fkey FOREIGN KEY (workspace_id,firm_id,evidence_id)
    REFERENCES evidence_items(workspace_id,firm_id,id) ON DELETE CASCADE,
  CONSTRAINT office_source_ordinal CHECK (ordinal BETWEEN 0 AND 7),
  CONSTRAINT office_source_observation CHECK (
    jsonb_typeof(observation) = 'object' AND observation ? 'id' AND observation->>'id' = observation_id::text
    AND observation ? 'blocks' AND jsonb_typeof(observation->'blocks') = 'array'
    AND CASE WHEN jsonb_typeof(observation->'blocks') = 'array' THEN jsonb_array_length(observation->'blocks') BETWEEN 1 AND 100 ELSE false END
    AND octet_length(observation::text) <= 131072),
  CONSTRAINT office_source_facts CHECK (jsonb_typeof(facts) = 'array'
    AND CASE WHEN jsonb_typeof(facts) = 'array' THEN jsonb_array_length(facts) <= 30 ELSE false END
    AND octet_length(facts::text) <= 65536)
);
CREATE INDEX office_sources_expiry ON firm_office_assessment_sources(workspace_id,expires_at);
CREATE INDEX office_sources_evidence ON firm_office_assessment_sources(workspace_id,evidence_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON firm_office_assessments,firm_office_assessment_sources TO app_runtime,migration;
